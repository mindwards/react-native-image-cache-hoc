/**
 *
 * This HOC adds the following functionality to react native <Image> components:
 *
 * - File caching. Images will be downloaded to a cache on the local file system.
 *   Cache is maintained until cache size meets a certain threshold at which point the oldest
 *   cached files are purged to make room for fresh files.
 *
 *  - File persistence. Images will be stored indefinitely on local file system.
 *    Required for images that are related to issues that have been downloaded for offline use.
 *
 * More info: https://facebook.github.io/react/docs/higher-order-components.html
 *
 */

// Load dependencies.
import React from 'react';
import { ViewPropTypes } from 'react-native';
import PropTypes from 'prop-types';
import FileSystemFactory, { FileSystem } from '../lib/FileSystem';
import traverse from 'traverse';
import validator from 'validator';
import uuid from 'react-native-uuid';
import makeCancelable from 'makecancelable';

export default function imageCacheHoc(Image, options = {}) {

  // Validate options
  if (options.validProtocols && !Array.isArray(options.validProtocols)) { throw new Error('validProtocols option must be an array of protocol strings.'); }
  if (options.fileHostWhitelist && !Array.isArray(options.fileHostWhitelist)) { throw new Error('fileHostWhitelist option must be an array of host strings.'); }
  if (options.cachePruneTriggerLimit && !Number.isInteger(options.cachePruneTriggerLimit) ) { throw new Error('cachePruneTriggerLimit option must be an integer.'); }
  if (options.fileDirName && typeof options.fileDirName !== 'string') { throw new Error('fileDirName option must be string'); }
  if (options.defaultPlaceholder && (!options.defaultPlaceholder.component || !options.defaultPlaceholder.props)) { throw new Error('defaultPlaceholder option object must include "component" and "props" properties (props can be an empty object)'); }

  return class extends React.PureComponent {

    static propTypes = {
      fileHostWhitelist: PropTypes.array,
      source: PropTypes.object.isRequired,
      permanent: PropTypes.bool,
      style: ViewPropTypes.style,
      placeholder: PropTypes.shape({
        component: PropTypes.func,
        props: PropTypes.object
      })
    };

    /**
     *
     * Manually cache a file.
     * Can be used to pre-warm caches.
     * If calling this method repeatedly to cache a long list of files,
     * be sure to use a queue and limit concurrency so your app performance does not suffer.
     *
     * @param url {String} - url of file to download.
     * @param permanent {Boolean} - whether the file should be saved to the tmp or permanent cache directory.
     * @returns {Promise} promise that resolves to an object that contains cached file info.
     */
    static async cacheFile(url, permanent = false) {

      const fileSystem = FileSystemFactory();
      const localFilePath = await fileSystem.getLocalFilePathFromUrl(url, permanent);

      return {
        url: url,
        cacheType: (permanent ? 'permanent' : 'cache'),
        localFilePath
      };

    }

    /**
     *
     * Delete all locally stored image files created by react-native-image-cache-hoc (cache AND permanent).
     * Calling this method will cause a performance hit on your app until the local files are rebuilt.
     *
     * @returns {Promise} promise that resolves to an object that contains the flush results.
     */
    static async flush() {

      const fileSystem = FileSystemFactory();
      const results = await Promise.all([fileSystem.unlink('permanent'), fileSystem.unlink('cache')]);

      return {
        permanentDirFlushed: results[0],
        cacheDirFlushed: results[1]
      };

    }

    constructor(props) {
      super(props);

      // Set initial state
      this.state = {
        localFilePath: null
      };

      // Assign component unique ID for cache locking.
      this.componentId = uuid.v4();

      // Set default options
      this.options = {
        validProtocols: options.validProtocols || ['https'],
        fileHostWhitelist: options.fileHostWhitelist || [],
        cachePruneTriggerLimit: options.cachePruneTriggerLimit || 1024 * 1024 * 15, // Maximum size of image file cache in bytes before pruning occurs. Defaults to 15 MB.
        fileDirName: options.fileDirName || null, // Namespace local file writing to this directory. Defaults to 'react-native-image-cache-hoc'.
        defaultPlaceholder: options.defaultPlaceholder || null, // Default placeholder component to render while remote image file is downloading. Can be overridden with placeholder prop. Defaults to <Image> component with style prop passed through.
        skipUriValidation: options.skipUriValidation || false, // Skip URL validation, useful for accessing ports other than 80 or 443. false by default
        fetchParamsCallback: options.fetchParamsCallback || null, // Callback to provide additional transformations to the url and adding headers, tipically to provide authorization creentials.
      };

      // Init file system lib
      this.fileSystem = FileSystemFactory(this.options.cachePruneTriggerLimit, this.options.fileDirName);

      // Validate input
      this._validateImageComponent();

    }

    _validateImageComponent() {

      // Define validator options
      let validatorUrlOptions = { protocols: this.options.validProtocols, require_protocol: true };
      if (this.options.fileHostWhitelist.length) {
        validatorUrlOptions.host_whitelist = this.options.fileHostWhitelist;
      }

      // Validate source prop to be a valid web accessible uri, unless skipUrlValidation option is set
      if (
        !traverse(this.props).get(['source', 'uri'])
        || (!this.options.skipUriValidation && !validator.isURL(traverse(this.props).get(['source', 'uri']), validatorUrlOptions))
      ) {
        throw new Error('Invalid source prop. <CacheableImage> props.source.uri should be a web accessible url with a valid protocol and host. NOTE: Default valid protocol is https, default valid hosts are *.');
      } else {
        return true;
      }

    }

    // Async calls to local FS or network should occur here.
    // See: https://reactjs.org/docs/react-component.html#componentdidmount
    async componentDidMount() {

      // Add a cache lock to file with this name (prevents concurrent <CacheableImage> components from pruning a file with this name from cache).
      let fileName = await this.fileSystem.getFileNameFromUrl(traverse(this.props).get(['source', 'uri']));
      FileSystem.lockCacheFile(fileName, this.componentId);

      // Check local fs for file, fallback to network and write file to disk if local file not found.
      // This must be cancelable in case component is unmounted before request completes.
      let permanent = this.props.permanent ? true : false;

      this.cancelLocalFilePathRequest = makeCancelable(
        this.fileSystem.getLocalFilePathFromUrl(traverse(this.props).get(['source', 'uri']), permanent),
        localFilePath => this.setState({ localFilePath }),
        error => console.error(error) // eslint-disable-line no-console
      );

    }

    async componentWillUnmount() {

      // Cancel pending setState() actions.
      // NOTE: must check this.cancelLocalFilePathRequest is set to avoid edge case where component is mounted then immediately unmounted before componentDidMount() fires.
      if (this.cancelLocalFilePathRequest) {
        this.cancelLocalFilePathRequest();
      }


      // Remove component cache lock on associated image file on component teardown.
      let fileName = await this.fileSystem.getFileNameFromUrl(traverse(this.props).get(['source', 'uri']));
      FileSystem.unlockCacheFile(fileName, this.componentId);

    }

    render() {

      // If media loaded, render full image component, else render placeholder.
      if (this.state.localFilePath) {

        // Extract props proprietary to this HOC before passing props through.
        let { permanent, ...filteredProps } = this.props; // eslint-disable-line no-unused-vars

        let props = Object.assign({}, filteredProps, { uri: this.state.localFilePath });
        return (<Image {...props} />);
      } else {

        if (this.props.placeholder) {
          return (<this.props.placeholder.component {...this.props.placeholder.props} />);
        } else if (this.options.defaultPlaceholder) {
          return (<this.options.defaultPlaceholder.component {...this.options.defaultPlaceholder.props} />);
        } else {
          return (<Image style={this.props.style ? this.props.style : undefined} />);
        }

      }

    }

  };

}
