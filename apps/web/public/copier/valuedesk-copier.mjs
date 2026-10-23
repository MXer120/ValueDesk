// ValueDesk copier 1.0.0 - the self-hosted copy executor. MIT licence.
// Run: node valuedesk-copier.mjs   (Node.js 22 or newer). Settings: see README (EXECUTOR_* variables).
// It talks to SoDEX and Hyperliquid directly and to nothing else; your copy key stays in ./copier-data.
import { createRequire as __vdRequire } from 'node:module'; const require = __vdRequire(import.meta.url);
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __require = /* @__PURE__ */ ((x) => typeof require !== "undefined" ? require : typeof Proxy !== "undefined" ? new Proxy(x, {
  get: (a, b) => (typeof require !== "undefined" ? require : a)[b]
}) : x)(function(x) {
  if (typeof require !== "undefined") return require.apply(this, arguments);
  throw Error('Dynamic require of "' + x + '" is not supported');
});
var __commonJS = (cb, mod2) => function __require2() {
  try {
    return mod2 || (0, cb[__getOwnPropNames(cb)[0]])((mod2 = { exports: {} }).exports, mod2), mod2.exports;
  } catch (e) {
    throw mod2 = 0, e;
  }
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key2 of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key2) && key2 !== except)
        __defProp(to, key2, { get: () => from[key2], enumerable: !(desc = __getOwnPropDesc(from, key2)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod2, isNodeMode, target) => (target = mod2 != null ? __create(__getProtoOf(mod2)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod2 || !mod2.__esModule ? __defProp(target, "default", { value: mod2, enumerable: true }) : target,
  mod2
));

// node_modules/ws/lib/constants.js
var require_constants = __commonJS({
  "node_modules/ws/lib/constants.js"(exports, module) {
    "use strict";
    var BINARY_TYPES = ["nodebuffer", "arraybuffer", "fragments"];
    var hasBlob = typeof Blob !== "undefined";
    if (hasBlob) BINARY_TYPES.push("blob");
    module.exports = {
      BINARY_TYPES,
      CLOSE_TIMEOUT: 3e4,
      EMPTY_BUFFER: Buffer.alloc(0),
      GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
      hasBlob,
      kForOnEventAttribute: /* @__PURE__ */ Symbol("kIsForOnEventAttribute"),
      kListener: /* @__PURE__ */ Symbol("kListener"),
      kStatusCode: /* @__PURE__ */ Symbol("status-code"),
      kWebSocket: /* @__PURE__ */ Symbol("websocket"),
      NOOP: () => {
      }
    };
  }
});

// node_modules/node-gyp-build/node-gyp-build.js
var require_node_gyp_build = __commonJS({
  "node_modules/node-gyp-build/node-gyp-build.js"(exports, module) {
    var fs = __require("fs");
    var path = __require("path");
    var os = __require("os");
    var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
    var vars = process.config && process.config.variables || {};
    var prebuildsOnly = !!process.env.PREBUILDS_ONLY;
    var abi = process.versions.modules;
    var runtime = isElectron() ? "electron" : isNwjs() ? "node-webkit" : "node";
    var arch = process.env.npm_config_arch || os.arch();
    var platform = process.env.npm_config_platform || os.platform();
    var libc = process.env.LIBC || (isAlpine(platform) ? "musl" : "glibc");
    var armv = process.env.ARM_VERSION || (arch === "arm64" ? "8" : vars.arm_version) || "";
    var uv = (process.versions.uv || "").split(".")[0];
    module.exports = load;
    function load(dir) {
      return runtimeRequire(load.resolve(dir));
    }
    load.resolve = load.path = function(dir) {
      dir = path.resolve(dir || ".");
      try {
        var name = runtimeRequire(path.join(dir, "package.json")).name.toUpperCase().replace(/-/g, "_");
        if (process.env[name + "_PREBUILD"]) dir = process.env[name + "_PREBUILD"];
      } catch (err) {
      }
      if (!prebuildsOnly) {
        var release = getFirst(path.join(dir, "build/Release"), matchBuild);
        if (release) return release;
        var debug = getFirst(path.join(dir, "build/Debug"), matchBuild);
        if (debug) return debug;
      }
      var prebuild = resolve2(dir);
      if (prebuild) return prebuild;
      var nearby = resolve2(path.dirname(process.execPath));
      if (nearby) return nearby;
      var target = [
        "platform=" + platform,
        "arch=" + arch,
        "runtime=" + runtime,
        "abi=" + abi,
        "uv=" + uv,
        armv ? "armv=" + armv : "",
        "libc=" + libc,
        "node=" + process.versions.node,
        process.versions.electron ? "electron=" + process.versions.electron : "",
        typeof __webpack_require__ === "function" ? "webpack=true" : ""
        // eslint-disable-line
      ].filter(Boolean).join(" ");
      throw new Error("No native build was found for " + target + "\n    loaded from: " + dir + "\n");
      function resolve2(dir2) {
        var tuples = readdirSync(path.join(dir2, "prebuilds")).map(parseTuple);
        var tuple = tuples.filter(matchTuple(platform, arch)).sort(compareTuples)[0];
        if (!tuple) return;
        var prebuilds = path.join(dir2, "prebuilds", tuple.name);
        var parsed = readdirSync(prebuilds).map(parseTags);
        var candidates = parsed.filter(matchTags(runtime, abi));
        var winner = candidates.sort(compareTags(runtime))[0];
        if (winner) return path.join(prebuilds, winner.file);
      }
    };
    function readdirSync(dir) {
      try {
        return fs.readdirSync(dir);
      } catch (err) {
        return [];
      }
    }
    function getFirst(dir, filter) {
      var files = readdirSync(dir).filter(filter);
      return files[0] && path.join(dir, files[0]);
    }
    function matchBuild(name) {
      return /\.node$/.test(name);
    }
    function parseTuple(name) {
      var arr = name.split("-");
      if (arr.length !== 2) return;
      var platform2 = arr[0];
      var architectures = arr[1].split("+");
      if (!platform2) return;
      if (!architectures.length) return;
      if (!architectures.every(Boolean)) return;
      return { name, platform: platform2, architectures };
    }
    function matchTuple(platform2, arch2) {
      return function(tuple) {
        if (tuple == null) return false;
        if (tuple.platform !== platform2) return false;
        return tuple.architectures.includes(arch2);
      };
    }
    function compareTuples(a, b) {
      return a.architectures.length - b.architectures.length;
    }
    function parseTags(file) {
      var arr = file.split(".");
      var extension2 = arr.pop();
      var tags = { file, specificity: 0 };
      if (extension2 !== "node") return;
      for (var i = 0; i < arr.length; i++) {
        var tag = arr[i];
        if (tag === "node" || tag === "electron" || tag === "node-webkit") {
          tags.runtime = tag;
        } else if (tag === "napi") {
          tags.napi = true;
        } else if (tag.slice(0, 3) === "abi") {
          tags.abi = tag.slice(3);
        } else if (tag.slice(0, 2) === "uv") {
          tags.uv = tag.slice(2);
        } else if (tag.slice(0, 4) === "armv") {
          tags.armv = tag.slice(4);
        } else if (tag === "glibc" || tag === "musl") {
          tags.libc = tag;
        } else {
          continue;
        }
        tags.specificity++;
      }
      return tags;
    }
    function matchTags(runtime2, abi2) {
      return function(tags) {
        if (tags == null) return false;
        if (tags.runtime && tags.runtime !== runtime2 && !runtimeAgnostic(tags)) return false;
        if (tags.abi && tags.abi !== abi2 && !tags.napi) return false;
        if (tags.uv && tags.uv !== uv) return false;
        if (tags.armv && tags.armv !== armv) return false;
        if (tags.libc && tags.libc !== libc) return false;
        return true;
      };
    }
    function runtimeAgnostic(tags) {
      return tags.runtime === "node" && tags.napi;
    }
    function compareTags(runtime2) {
      return function(a, b) {
        if (a.runtime !== b.runtime) {
          return a.runtime === runtime2 ? -1 : 1;
        } else if (a.abi !== b.abi) {
          return a.abi ? -1 : 1;
        } else if (a.specificity !== b.specificity) {
          return a.specificity > b.specificity ? -1 : 1;
        } else {
          return 0;
        }
      };
    }
    function isNwjs() {
      return !!(process.versions && process.versions.nw);
    }
    function isElectron() {
      if (process.versions && process.versions.electron) return true;
      if (process.env.ELECTRON_RUN_AS_NODE) return true;
      return typeof window !== "undefined" && window.process && window.process.type === "renderer";
    }
    function isAlpine(platform2) {
      return platform2 === "linux" && fs.existsSync("/etc/alpine-release");
    }
    load.parseTags = parseTags;
    load.matchTags = matchTags;
    load.compareTags = compareTags;
    load.parseTuple = parseTuple;
    load.matchTuple = matchTuple;
    load.compareTuples = compareTuples;
  }
});

// node_modules/node-gyp-build/index.js
var require_node_gyp_build2 = __commonJS({
  "node_modules/node-gyp-build/index.js"(exports, module) {
    var runtimeRequire = typeof __webpack_require__ === "function" ? __non_webpack_require__ : __require;
    if (typeof runtimeRequire.addon === "function") {
      module.exports = runtimeRequire.addon.bind(runtimeRequire);
    } else {
      module.exports = require_node_gyp_build();
    }
  }
});

// node_modules/bufferutil/fallback.js
var require_fallback = __commonJS({
  "node_modules/bufferutil/fallback.js"(exports, module) {
    "use strict";
    var mask = (source, mask2, output, offset, length) => {
      for (var i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask2[i & 3];
      }
    };
    var unmask = (buffer, mask2) => {
      const length = buffer.length;
      for (var i = 0; i < length; i++) {
        buffer[i] ^= mask2[i & 3];
      }
    };
    module.exports = { mask, unmask };
  }
});

// node_modules/bufferutil/index.js
var require_bufferutil = __commonJS({
  "node_modules/bufferutil/index.js"(exports, module) {
    "use strict";
    try {
      module.exports = require_node_gyp_build2()(__dirname);
    } catch (e) {
      module.exports = require_fallback();
    }
  }
});

// node_modules/ws/lib/buffer-util.js
var require_buffer_util = __commonJS({
  "node_modules/ws/lib/buffer-util.js"(exports, module) {
    "use strict";
    var { EMPTY_BUFFER } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    function concat2(list, totalLength) {
      if (list.length === 0) return EMPTY_BUFFER;
      if (list.length === 1) return list[0];
      const target = Buffer.allocUnsafe(totalLength);
      let offset = 0;
      for (let i = 0; i < list.length; i++) {
        const buf = list[i];
        target.set(buf, offset);
        offset += buf.length;
      }
      if (offset < totalLength) {
        return new FastBuffer(target.buffer, target.byteOffset, offset);
      }
      return target;
    }
    function _mask(source, mask, output, offset, length) {
      for (let i = 0; i < length; i++) {
        output[offset + i] = source[i] ^ mask[i & 3];
      }
    }
    function _unmask(buffer, mask) {
      for (let i = 0; i < buffer.length; i++) {
        buffer[i] ^= mask[i & 3];
      }
    }
    function toArrayBuffer(buf) {
      if (buf.length === buf.buffer.byteLength) {
        return buf.buffer;
      }
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
    }
    function toBuffer(data) {
      toBuffer.readOnly = true;
      if (Buffer.isBuffer(data)) return data;
      let buf;
      if (data instanceof ArrayBuffer) {
        buf = new FastBuffer(data);
      } else if (ArrayBuffer.isView(data)) {
        buf = new FastBuffer(data.buffer, data.byteOffset, data.byteLength);
      } else {
        buf = Buffer.from(data);
        toBuffer.readOnly = false;
      }
      return buf;
    }
    module.exports = {
      concat: concat2,
      mask: _mask,
      toArrayBuffer,
      toBuffer,
      unmask: _unmask
    };
    if (!process.env.WS_NO_BUFFER_UTIL) {
      try {
        const bufferUtil = require_bufferutil();
        module.exports.mask = function(source, mask, output, offset, length) {
          if (length < 48) _mask(source, mask, output, offset, length);
          else bufferUtil.mask(source, mask, output, offset, length);
        };
        module.exports.unmask = function(buffer, mask) {
          if (buffer.length < 32) _unmask(buffer, mask);
          else bufferUtil.unmask(buffer, mask);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/limiter.js
var require_limiter = __commonJS({
  "node_modules/ws/lib/limiter.js"(exports, module) {
    "use strict";
    var kDone = /* @__PURE__ */ Symbol("kDone");
    var kRun = /* @__PURE__ */ Symbol("kRun");
    var Limiter2 = class {
      /**
       * Creates a new `Limiter`.
       *
       * @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
       *     to run concurrently
       */
      constructor(concurrency) {
        this[kDone] = () => {
          this.pending--;
          this[kRun]();
        };
        this.concurrency = concurrency || Infinity;
        this.jobs = [];
        this.pending = 0;
      }
      /**
       * Adds a job to the queue.
       *
       * @param {Function} job The job to run
       * @public
       */
      add(job) {
        this.jobs.push(job);
        this[kRun]();
      }
      /**
       * Removes a job from the queue and runs it if possible.
       *
       * @private
       */
      [kRun]() {
        if (this.pending === this.concurrency) return;
        if (this.jobs.length) {
          const job = this.jobs.shift();
          this.pending++;
          job(this[kDone]);
        }
      }
    };
    module.exports = Limiter2;
  }
});

// node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = __commonJS({
  "node_modules/ws/lib/permessage-deflate.js"(exports, module) {
    "use strict";
    var zlib = __require("zlib");
    var bufferUtil = require_buffer_util();
    var Limiter2 = require_limiter();
    var { kStatusCode } = require_constants();
    var FastBuffer = Buffer[Symbol.species];
    var TRAILER = Buffer.from([0, 0, 255, 255]);
    var kPerMessageDeflate = /* @__PURE__ */ Symbol("permessage-deflate");
    var kTotalLength = /* @__PURE__ */ Symbol("total-length");
    var kCallback = /* @__PURE__ */ Symbol("callback");
    var kBuffers = /* @__PURE__ */ Symbol("buffers");
    var kError = /* @__PURE__ */ Symbol("error");
    var zlibLimiter;
    var PerMessageDeflate2 = class {
      /**
       * Creates a PerMessageDeflate instance.
       *
       * @param {Object} [options] Configuration options
       * @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
       *     for, or request, a custom client window size
       * @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
       *     acknowledge disabling of client context takeover
       * @param {Number} [options.concurrencyLimit=10] The number of concurrent
       *     calls to zlib
       * @param {Boolean} [options.isServer=false] Create the instance in either
       *     server or client mode
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
       *     use of a custom server window size
       * @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
       *     disabling of server context takeover
       * @param {Number} [options.threshold=1024] Size (in bytes) below which
       *     messages should not be compressed if context takeover is disabled
       * @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
       *     deflate
       * @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
       *     inflate
       */
      constructor(options) {
        this._options = options || {};
        this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
        this._maxPayload = this._options.maxPayload | 0;
        this._isServer = !!this._options.isServer;
        this._deflate = null;
        this._inflate = null;
        this.params = null;
        if (!zlibLimiter) {
          const concurrency = this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10;
          zlibLimiter = new Limiter2(concurrency);
        }
      }
      /**
       * @type {String}
       */
      static get extensionName() {
        return "permessage-deflate";
      }
      /**
       * Create an extension negotiation offer.
       *
       * @return {Object} Extension parameters
       * @public
       */
      offer() {
        const params = {};
        if (this._options.serverNoContextTakeover) {
          params.server_no_context_takeover = true;
        }
        if (this._options.clientNoContextTakeover) {
          params.client_no_context_takeover = true;
        }
        if (this._options.serverMaxWindowBits) {
          params.server_max_window_bits = this._options.serverMaxWindowBits;
        }
        if (this._options.clientMaxWindowBits) {
          params.client_max_window_bits = this._options.clientMaxWindowBits;
        } else if (this._options.clientMaxWindowBits == null) {
          params.client_max_window_bits = true;
        }
        return params;
      }
      /**
       * Accept an extension negotiation offer/response.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Object} Accepted configuration
       * @public
       */
      accept(configurations) {
        configurations = this.normalizeParams(configurations);
        this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
        return this.params;
      }
      /**
       * Releases all resources used by the extension.
       *
       * @public
       */
      cleanup() {
        if (this._inflate) {
          this._inflate.close();
          this._inflate = null;
        }
        if (this._deflate) {
          const callback = this._deflate[kCallback];
          this._deflate.close();
          this._deflate = null;
          if (callback) {
            callback(
              new Error(
                "The deflate stream was closed while data was being processed"
              )
            );
          }
        }
      }
      /**
       *  Accept an extension negotiation offer.
       *
       * @param {Array} offers The extension negotiation offers
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsServer(offers) {
        const opts = this._options;
        const accepted = offers.find((params) => {
          if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) {
            return false;
          }
          return true;
        });
        if (!accepted) {
          throw new Error("None of the extension offers can be accepted");
        }
        if (opts.serverNoContextTakeover) {
          accepted.server_no_context_takeover = true;
        }
        if (opts.clientNoContextTakeover) {
          accepted.client_no_context_takeover = true;
        }
        if (typeof opts.serverMaxWindowBits === "number") {
          accepted.server_max_window_bits = opts.serverMaxWindowBits;
        }
        if (typeof opts.clientMaxWindowBits === "number") {
          accepted.client_max_window_bits = opts.clientMaxWindowBits;
        } else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) {
          delete accepted.client_max_window_bits;
        }
        return accepted;
      }
      /**
       * Accept the extension negotiation response.
       *
       * @param {Array} response The extension negotiation response
       * @return {Object} Accepted configuration
       * @private
       */
      acceptAsClient(response) {
        const params = response[0];
        if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) {
          throw new Error('Unexpected parameter "client_no_context_takeover"');
        }
        if (!params.client_max_window_bits) {
          if (typeof this._options.clientMaxWindowBits === "number") {
            params.client_max_window_bits = this._options.clientMaxWindowBits;
          }
        } else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) {
          throw new Error(
            'Unexpected or invalid parameter "client_max_window_bits"'
          );
        }
        return params;
      }
      /**
       * Normalize parameters.
       *
       * @param {Array} configurations The extension negotiation offers/reponse
       * @return {Array} The offers/response with normalized parameters
       * @private
       */
      normalizeParams(configurations) {
        configurations.forEach((params) => {
          Object.keys(params).forEach((key2) => {
            let value = params[key2];
            if (value.length > 1) {
              throw new Error(`Parameter "${key2}" must have only a single value`);
            }
            value = value[0];
            if (key2 === "client_max_window_bits") {
              if (value !== true) {
                const num3 = +value;
                if (!Number.isInteger(num3) || num3 < 8 || num3 > 15) {
                  throw new TypeError(
                    `Invalid value for parameter "${key2}": ${value}`
                  );
                }
                value = num3;
              } else if (!this._isServer) {
                throw new TypeError(
                  `Invalid value for parameter "${key2}": ${value}`
                );
              }
            } else if (key2 === "server_max_window_bits") {
              const num3 = +value;
              if (!Number.isInteger(num3) || num3 < 8 || num3 > 15) {
                throw new TypeError(
                  `Invalid value for parameter "${key2}": ${value}`
                );
              }
              value = num3;
            } else if (key2 === "client_no_context_takeover" || key2 === "server_no_context_takeover") {
              if (value !== true) {
                throw new TypeError(
                  `Invalid value for parameter "${key2}": ${value}`
                );
              }
            } else {
              throw new Error(`Unknown parameter "${key2}"`);
            }
            params[key2] = value;
          });
        });
        return configurations;
      }
      /**
       * Decompress data. Concurrency limited.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      decompress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._decompress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Compress data. Concurrency limited.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @public
       */
      compress(data, fin, callback) {
        zlibLimiter.add((done) => {
          this._compress(data, fin, (err, result) => {
            done();
            callback(err, result);
          });
        });
      }
      /**
       * Decompress data.
       *
       * @param {Buffer} data Compressed data
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _decompress(data, fin, callback) {
        const endpoint = this._isServer ? "client" : "server";
        if (!this._inflate) {
          const key2 = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key2] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key2];
          this._inflate = zlib.createInflateRaw({
            ...this._options.zlibInflateOptions,
            windowBits
          });
          this._inflate[kPerMessageDeflate] = this;
          this._inflate[kTotalLength] = 0;
          this._inflate[kBuffers] = [];
          this._inflate.on("error", inflateOnError);
          this._inflate.on("data", inflateOnData);
        }
        this._inflate[kCallback] = callback;
        this._inflate.write(data);
        if (fin) this._inflate.write(TRAILER);
        this._inflate.flush(() => {
          const err = this._inflate[kError];
          if (err) {
            this._inflate.close();
            this._inflate = null;
            callback(err);
            return;
          }
          const data2 = bufferUtil.concat(
            this._inflate[kBuffers],
            this._inflate[kTotalLength]
          );
          if (this._inflate._readableState.endEmitted) {
            this._inflate.close();
            this._inflate = null;
          } else {
            this._inflate[kTotalLength] = 0;
            this._inflate[kBuffers] = [];
            if (fin && this.params[`${endpoint}_no_context_takeover`]) {
              this._inflate.reset();
            }
          }
          callback(null, data2);
        });
      }
      /**
       * Compress data.
       *
       * @param {(Buffer|String)} data Data to compress
       * @param {Boolean} fin Specifies whether or not this is the last fragment
       * @param {Function} callback Callback
       * @private
       */
      _compress(data, fin, callback) {
        const endpoint = this._isServer ? "server" : "client";
        if (!this._deflate) {
          const key2 = `${endpoint}_max_window_bits`;
          const windowBits = typeof this.params[key2] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key2];
          this._deflate = zlib.createDeflateRaw({
            ...this._options.zlibDeflateOptions,
            windowBits
          });
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          this._deflate.on("data", deflateOnData);
        }
        this._deflate[kCallback] = callback;
        this._deflate.write(data);
        this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
          if (!this._deflate) {
            return;
          }
          let data2 = bufferUtil.concat(
            this._deflate[kBuffers],
            this._deflate[kTotalLength]
          );
          if (fin) {
            data2 = new FastBuffer(data2.buffer, data2.byteOffset, data2.length - 4);
          }
          this._deflate[kCallback] = null;
          this._deflate[kTotalLength] = 0;
          this._deflate[kBuffers] = [];
          if (fin && this.params[`${endpoint}_no_context_takeover`]) {
            this._deflate.reset();
          }
          callback(null, data2);
        });
      }
    };
    module.exports = PerMessageDeflate2;
    function deflateOnData(chunk) {
      this[kBuffers].push(chunk);
      this[kTotalLength] += chunk.length;
    }
    function inflateOnData(chunk) {
      this[kTotalLength] += chunk.length;
      if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
        this[kBuffers].push(chunk);
        return;
      }
      this[kError] = new RangeError("Max payload size exceeded");
      this[kError].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
      this[kError][kStatusCode] = 1009;
      this.removeListener("data", inflateOnData);
      this.reset();
    }
    function inflateOnError(err) {
      this[kPerMessageDeflate]._inflate = null;
      if (this[kError]) {
        this[kCallback](this[kError]);
        return;
      }
      err[kStatusCode] = 1007;
      this[kCallback](err);
    }
  }
});

// node_modules/utf-8-validate/fallback.js
var require_fallback2 = __commonJS({
  "node_modules/utf-8-validate/fallback.js"(exports, module) {
    "use strict";
    function isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    module.exports = isValidUTF8;
  }
});

// node_modules/utf-8-validate/index.js
var require_utf_8_validate = __commonJS({
  "node_modules/utf-8-validate/index.js"(exports, module) {
    "use strict";
    try {
      module.exports = require_node_gyp_build2()(__dirname);
    } catch (e) {
      module.exports = require_fallback2();
    }
  }
});

// node_modules/ws/lib/validation.js
var require_validation = __commonJS({
  "node_modules/ws/lib/validation.js"(exports, module) {
    "use strict";
    var { isUtf8 } = __require("buffer");
    var { hasBlob } = require_constants();
    var tokenChars = [
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 0 - 15
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      // 16 - 31
      0,
      1,
      0,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      1,
      1,
      0,
      1,
      1,
      0,
      // 32 - 47
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      0,
      0,
      0,
      // 48 - 63
      0,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 64 - 79
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      0,
      0,
      1,
      1,
      // 80 - 95
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      // 96 - 111
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      1,
      0,
      1,
      0,
      1,
      0
      // 112 - 127
    ];
    function isValidStatusCode(code) {
      return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
    }
    function _isValidUTF8(buf) {
      const len = buf.length;
      let i = 0;
      while (i < len) {
        if ((buf[i] & 128) === 0) {
          i++;
        } else if ((buf[i] & 224) === 192) {
          if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) {
            return false;
          }
          i += 2;
        } else if ((buf[i] & 240) === 224) {
          if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || // Overlong
          buf[i] === 237 && (buf[i + 1] & 224) === 160) {
            return false;
          }
          i += 3;
        } else if ((buf[i] & 248) === 240) {
          if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || // Overlong
          buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) {
            return false;
          }
          i += 4;
        } else {
          return false;
        }
      }
      return true;
    }
    function isBlob(value) {
      return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
    }
    module.exports = {
      isBlob,
      isValidStatusCode,
      isValidUTF8: _isValidUTF8,
      tokenChars
    };
    if (isUtf8) {
      module.exports.isValidUTF8 = function(buf) {
        return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
      };
    } else if (!process.env.WS_NO_UTF_8_VALIDATE) {
      try {
        const isValidUTF8 = require_utf_8_validate();
        module.exports.isValidUTF8 = function(buf) {
          return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8(buf);
        };
      } catch (e) {
      }
    }
  }
});

// node_modules/ws/lib/receiver.js
var require_receiver = __commonJS({
  "node_modules/ws/lib/receiver.js"(exports, module) {
    "use strict";
    var { Writable } = __require("stream");
    var PerMessageDeflate2 = require_permessage_deflate();
    var {
      BINARY_TYPES,
      EMPTY_BUFFER,
      kStatusCode,
      kWebSocket
    } = require_constants();
    var { concat: concat2, toArrayBuffer, unmask } = require_buffer_util();
    var { isValidStatusCode, isValidUTF8 } = require_validation();
    var FastBuffer = Buffer[Symbol.species];
    var GET_INFO = 0;
    var GET_PAYLOAD_LENGTH_16 = 1;
    var GET_PAYLOAD_LENGTH_64 = 2;
    var GET_MASK = 3;
    var GET_DATA = 4;
    var INFLATING = 5;
    var DEFER_EVENT = 6;
    var Receiver2 = class extends Writable {
      /**
       * Creates a Receiver instance.
       *
       * @param {Object} [options] Options object
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {String} [options.binaryType=nodebuffer] The type for binary data
       * @param {Object} [options.extensions] An object containing the negotiated
       *     extensions
       * @param {Boolean} [options.isServer=false] Specifies whether to operate in
       *     client or server mode
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message length
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       */
      constructor(options = {}) {
        super();
        this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
        this._binaryType = options.binaryType || BINARY_TYPES[0];
        this._extensions = options.extensions || {};
        this._isServer = !!options.isServer;
        this._maxBufferedChunks = options.maxBufferedChunks | 0;
        this._maxFragments = options.maxFragments | 0;
        this._maxPayload = options.maxPayload | 0;
        this._skipUTF8Validation = !!options.skipUTF8Validation;
        this[kWebSocket] = void 0;
        this._bufferedBytes = 0;
        this._buffers = [];
        this._compressed = false;
        this._payloadLength = 0;
        this._mask = void 0;
        this._fragmented = 0;
        this._masked = false;
        this._fin = false;
        this._opcode = 0;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._numFragments = 0;
        this._fragments = [];
        this._errored = false;
        this._loop = false;
        this._state = GET_INFO;
      }
      /**
       * Implements `Writable.prototype._write()`.
       *
       * @param {Buffer} chunk The chunk of data to write
       * @param {String} encoding The character encoding of `chunk`
       * @param {Function} cb Callback
       * @private
       */
      _write(chunk, encoding, cb) {
        if (this._opcode === 8 && this._state == GET_INFO) return cb();
        if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
          cb(
            this.createError(
              RangeError,
              "Too many buffered chunks",
              false,
              1008,
              "WS_ERR_TOO_MANY_BUFFERED_PARTS"
            )
          );
          return;
        }
        this._bufferedBytes += chunk.length;
        this._buffers.push(chunk);
        this.startLoop(cb);
      }
      /**
       * Consumes `n` bytes from the buffered data.
       *
       * @param {Number} n The number of bytes to consume
       * @return {Buffer} The consumed bytes
       * @private
       */
      consume(n) {
        this._bufferedBytes -= n;
        if (n === this._buffers[0].length) return this._buffers.shift();
        if (n < this._buffers[0].length) {
          const buf = this._buffers[0];
          this._buffers[0] = new FastBuffer(
            buf.buffer,
            buf.byteOffset + n,
            buf.length - n
          );
          return new FastBuffer(buf.buffer, buf.byteOffset, n);
        }
        const dst = Buffer.allocUnsafe(n);
        do {
          const buf = this._buffers[0];
          const offset = dst.length - n;
          if (n >= buf.length) {
            dst.set(this._buffers.shift(), offset);
          } else {
            dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
            this._buffers[0] = new FastBuffer(
              buf.buffer,
              buf.byteOffset + n,
              buf.length - n
            );
          }
          n -= buf.length;
        } while (n > 0);
        return dst;
      }
      /**
       * Starts the parsing loop.
       *
       * @param {Function} cb Callback
       * @private
       */
      startLoop(cb) {
        this._loop = true;
        do {
          switch (this._state) {
            case GET_INFO:
              this.getInfo(cb);
              break;
            case GET_PAYLOAD_LENGTH_16:
              this.getPayloadLength16(cb);
              break;
            case GET_PAYLOAD_LENGTH_64:
              this.getPayloadLength64(cb);
              break;
            case GET_MASK:
              this.getMask();
              break;
            case GET_DATA:
              this.getData(cb);
              break;
            case INFLATING:
            case DEFER_EVENT:
              this._loop = false;
              return;
          }
        } while (this._loop);
        if (!this._errored) cb();
      }
      /**
       * Reads the first two bytes of a frame.
       *
       * @param {Function} cb Callback
       * @private
       */
      getInfo(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        const buf = this.consume(2);
        if ((buf[0] & 48) !== 0) {
          const error = this.createError(
            RangeError,
            "RSV2 and RSV3 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_2_3"
          );
          cb(error);
          return;
        }
        const compressed = (buf[0] & 64) === 64;
        if (compressed && !this._extensions[PerMessageDeflate2.extensionName]) {
          const error = this.createError(
            RangeError,
            "RSV1 must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_RSV_1"
          );
          cb(error);
          return;
        }
        this._fin = (buf[0] & 128) === 128;
        this._opcode = buf[0] & 15;
        this._payloadLength = buf[1] & 127;
        if (this._opcode === 0) {
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (!this._fragmented) {
            const error = this.createError(
              RangeError,
              "invalid opcode 0",
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._opcode = this._fragmented;
        } else if (this._opcode === 1 || this._opcode === 2) {
          if (this._fragmented) {
            const error = this.createError(
              RangeError,
              `invalid opcode ${this._opcode}`,
              true,
              1002,
              "WS_ERR_INVALID_OPCODE"
            );
            cb(error);
            return;
          }
          this._compressed = compressed;
        } else if (this._opcode > 7 && this._opcode < 11) {
          if (!this._fin) {
            const error = this.createError(
              RangeError,
              "FIN must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_FIN"
            );
            cb(error);
            return;
          }
          if (compressed) {
            const error = this.createError(
              RangeError,
              "RSV1 must be clear",
              true,
              1002,
              "WS_ERR_UNEXPECTED_RSV_1"
            );
            cb(error);
            return;
          }
          if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
            const error = this.createError(
              RangeError,
              `invalid payload length ${this._payloadLength}`,
              true,
              1002,
              "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"
            );
            cb(error);
            return;
          }
        } else {
          const error = this.createError(
            RangeError,
            `invalid opcode ${this._opcode}`,
            true,
            1002,
            "WS_ERR_INVALID_OPCODE"
          );
          cb(error);
          return;
        }
        if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
        this._masked = (buf[1] & 128) === 128;
        if (this._isServer) {
          if (!this._masked) {
            const error = this.createError(
              RangeError,
              "MASK must be set",
              true,
              1002,
              "WS_ERR_EXPECTED_MASK"
            );
            cb(error);
            return;
          }
        } else if (this._masked) {
          const error = this.createError(
            RangeError,
            "MASK must be clear",
            true,
            1002,
            "WS_ERR_UNEXPECTED_MASK"
          );
          cb(error);
          return;
        }
        if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
        else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
        else this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+16).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength16(cb) {
        if (this._bufferedBytes < 2) {
          this._loop = false;
          return;
        }
        this._payloadLength = this.consume(2).readUInt16BE(0);
        this.haveLength(cb);
      }
      /**
       * Gets extended payload length (7+64).
       *
       * @param {Function} cb Callback
       * @private
       */
      getPayloadLength64(cb) {
        if (this._bufferedBytes < 8) {
          this._loop = false;
          return;
        }
        const buf = this.consume(8);
        const num3 = buf.readUInt32BE(0);
        if (num3 > Math.pow(2, 53 - 32) - 1) {
          const error = this.createError(
            RangeError,
            "Unsupported WebSocket frame: payload length > 2^53 - 1",
            false,
            1009,
            "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"
          );
          cb(error);
          return;
        }
        this._payloadLength = num3 * Math.pow(2, 32) + buf.readUInt32BE(4);
        this.haveLength(cb);
      }
      /**
       * Payload length has been read.
       *
       * @param {Function} cb Callback
       * @private
       */
      haveLength(cb) {
        if (this._payloadLength && this._opcode < 8) {
          this._totalPayloadLength += this._payloadLength;
          if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
            const error = this.createError(
              RangeError,
              "Max payload size exceeded",
              false,
              1009,
              "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
            );
            cb(error);
            return;
          }
        }
        if (this._masked) this._state = GET_MASK;
        else this._state = GET_DATA;
      }
      /**
       * Reads mask bytes.
       *
       * @private
       */
      getMask() {
        if (this._bufferedBytes < 4) {
          this._loop = false;
          return;
        }
        this._mask = this.consume(4);
        this._state = GET_DATA;
      }
      /**
       * Reads data bytes.
       *
       * @param {Function} cb Callback
       * @private
       */
      getData(cb) {
        let data = EMPTY_BUFFER;
        if (this._payloadLength) {
          if (this._bufferedBytes < this._payloadLength) {
            this._loop = false;
            return;
          }
          data = this.consume(this._payloadLength);
          if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) {
            unmask(data, this._mask);
          }
        }
        if (this._opcode > 7) {
          this.controlMessage(data, cb);
          return;
        }
        if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
          const error = this.createError(
            RangeError,
            "Too many message fragments",
            false,
            1008,
            "WS_ERR_TOO_MANY_BUFFERED_PARTS"
          );
          cb(error);
          return;
        }
        if (this._compressed) {
          this._state = INFLATING;
          this.decompress(data, cb);
          return;
        }
        if (data.length) {
          this._messageLength = this._totalPayloadLength;
          this._fragments.push(data);
        }
        this.dataMessage(cb);
      }
      /**
       * Decompresses data.
       *
       * @param {Buffer} data Compressed data
       * @param {Function} cb Callback
       * @private
       */
      decompress(data, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        perMessageDeflate.decompress(data, this._fin, (err, buf) => {
          if (err) return cb(err);
          if (buf.length) {
            this._messageLength += buf.length;
            if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
              const error = this.createError(
                RangeError,
                "Max payload size exceeded",
                false,
                1009,
                "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"
              );
              cb(error);
              return;
            }
            this._fragments.push(buf);
          }
          this.dataMessage(cb);
          if (this._state === GET_INFO) this.startLoop(cb);
        });
      }
      /**
       * Handles a data message.
       *
       * @param {Function} cb Callback
       * @private
       */
      dataMessage(cb) {
        if (!this._fin) {
          this._state = GET_INFO;
          return;
        }
        const messageLength = this._messageLength;
        const fragments = this._fragments;
        this._totalPayloadLength = 0;
        this._messageLength = 0;
        this._fragmented = 0;
        this._numFragments = 0;
        this._fragments = [];
        if (this._opcode === 2) {
          let data;
          if (this._binaryType === "nodebuffer") {
            data = concat2(fragments, messageLength);
          } else if (this._binaryType === "arraybuffer") {
            data = toArrayBuffer(concat2(fragments, messageLength));
          } else if (this._binaryType === "blob") {
            data = new Blob(fragments);
          } else {
            data = fragments;
          }
          if (this._allowSynchronousEvents) {
            this.emit("message", data, true);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", data, true);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        } else {
          const buf = concat2(fragments, messageLength);
          if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
            const error = this.createError(
              Error,
              "invalid UTF-8 sequence",
              true,
              1007,
              "WS_ERR_INVALID_UTF8"
            );
            cb(error);
            return;
          }
          if (this._state === INFLATING || this._allowSynchronousEvents) {
            this.emit("message", buf, false);
            this._state = GET_INFO;
          } else {
            this._state = DEFER_EVENT;
            setImmediate(() => {
              this.emit("message", buf, false);
              this._state = GET_INFO;
              this.startLoop(cb);
            });
          }
        }
      }
      /**
       * Handles a control message.
       *
       * @param {Buffer} data Data to handle
       * @return {(Error|RangeError|undefined)} A possible error
       * @private
       */
      controlMessage(data, cb) {
        if (this._opcode === 8) {
          if (data.length === 0) {
            this._loop = false;
            this.emit("conclude", 1005, EMPTY_BUFFER);
            this.end();
          } else {
            const code = data.readUInt16BE(0);
            if (!isValidStatusCode(code)) {
              const error = this.createError(
                RangeError,
                `invalid status code ${code}`,
                true,
                1002,
                "WS_ERR_INVALID_CLOSE_CODE"
              );
              cb(error);
              return;
            }
            const buf = new FastBuffer(
              data.buffer,
              data.byteOffset + 2,
              data.length - 2
            );
            if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
              const error = this.createError(
                Error,
                "invalid UTF-8 sequence",
                true,
                1007,
                "WS_ERR_INVALID_UTF8"
              );
              cb(error);
              return;
            }
            this._loop = false;
            this.emit("conclude", code, buf);
            this.end();
          }
          this._state = GET_INFO;
          return;
        }
        if (this._allowSynchronousEvents) {
          this.emit(this._opcode === 9 ? "ping" : "pong", data);
          this._state = GET_INFO;
        } else {
          this._state = DEFER_EVENT;
          setImmediate(() => {
            this.emit(this._opcode === 9 ? "ping" : "pong", data);
            this._state = GET_INFO;
            this.startLoop(cb);
          });
        }
      }
      /**
       * Builds an error object.
       *
       * @param {function(new:Error|RangeError)} ErrorCtor The error constructor
       * @param {String} message The error message
       * @param {Boolean} prefix Specifies whether or not to add a default prefix to
       *     `message`
       * @param {Number} statusCode The status code
       * @param {String} errorCode The exposed error code
       * @return {(Error|RangeError)} The error
       * @private
       */
      createError(ErrorCtor, message, prefix, statusCode, errorCode) {
        this._loop = false;
        this._errored = true;
        const err = new ErrorCtor(
          prefix ? `Invalid WebSocket frame: ${message}` : message
        );
        Error.captureStackTrace(err, this.createError);
        err.code = errorCode;
        err[kStatusCode] = statusCode;
        return err;
      }
    };
    module.exports = Receiver2;
  }
});

// node_modules/ws/lib/sender.js
var require_sender = __commonJS({
  "node_modules/ws/lib/sender.js"(exports, module) {
    "use strict";
    var { Duplex } = __require("stream");
    var { randomFillSync } = __require("crypto");
    var {
      types: { isUint8Array }
    } = __require("util");
    var PerMessageDeflate2 = require_permessage_deflate();
    var { EMPTY_BUFFER, kWebSocket, NOOP } = require_constants();
    var { isBlob, isValidStatusCode } = require_validation();
    var { mask: applyMask, toBuffer } = require_buffer_util();
    var kByteLength = /* @__PURE__ */ Symbol("kByteLength");
    var maskBuffer = Buffer.alloc(4);
    var RANDOM_POOL_SIZE = 8 * 1024;
    var randomPool;
    var randomPoolPointer = RANDOM_POOL_SIZE;
    var DEFAULT = 0;
    var DEFLATING = 1;
    var GET_BLOB_DATA = 2;
    var Sender2 = class _Sender {
      /**
       * Creates a Sender instance.
       *
       * @param {Duplex} socket The connection socket
       * @param {Object} [extensions] An object containing the negotiated extensions
       * @param {Function} [generateMask] The function used to generate the masking
       *     key
       */
      constructor(socket, extensions, generateMask) {
        this._extensions = extensions || {};
        if (generateMask) {
          this._generateMask = generateMask;
          this._maskBuffer = Buffer.alloc(4);
        }
        this._socket = socket;
        this._firstFragment = true;
        this._compress = false;
        this._bufferedBytes = 0;
        this._queue = [];
        this._state = DEFAULT;
        this.onerror = NOOP;
        this[kWebSocket] = void 0;
      }
      /**
       * Frames a piece of data according to the HyBi WebSocket protocol.
       *
       * @param {(Buffer|String)} data The data to frame
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @return {(Buffer|String)[]} The framed data
       * @public
       */
      static frame(data, options) {
        let mask;
        let merge = false;
        let offset = 2;
        let skipMasking = false;
        if (options.mask) {
          mask = options.maskBuffer || maskBuffer;
          if (options.generateMask) {
            options.generateMask(mask);
          } else {
            if (randomPoolPointer === RANDOM_POOL_SIZE) {
              if (randomPool === void 0) {
                randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
              }
              randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
              randomPoolPointer = 0;
            }
            mask[0] = randomPool[randomPoolPointer++];
            mask[1] = randomPool[randomPoolPointer++];
            mask[2] = randomPool[randomPoolPointer++];
            mask[3] = randomPool[randomPoolPointer++];
          }
          skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
          offset = 6;
        }
        let dataLength;
        if (typeof data === "string") {
          if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) {
            dataLength = options[kByteLength];
          } else {
            data = Buffer.from(data);
            dataLength = data.length;
          }
        } else {
          dataLength = data.length;
          merge = options.mask && options.readOnly && !skipMasking;
        }
        let payloadLength = dataLength;
        if (dataLength >= 65536) {
          offset += 8;
          payloadLength = 127;
        } else if (dataLength > 125) {
          offset += 2;
          payloadLength = 126;
        }
        const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
        target[0] = options.fin ? options.opcode | 128 : options.opcode;
        if (options.rsv1) target[0] |= 64;
        target[1] = payloadLength;
        if (payloadLength === 126) {
          target.writeUInt16BE(dataLength, 2);
        } else if (payloadLength === 127) {
          target[2] = target[3] = 0;
          target.writeUIntBE(dataLength, 4, 6);
        }
        if (!options.mask) return [target, data];
        target[1] |= 128;
        target[offset - 4] = mask[0];
        target[offset - 3] = mask[1];
        target[offset - 2] = mask[2];
        target[offset - 1] = mask[3];
        if (skipMasking) return [target, data];
        if (merge) {
          applyMask(data, mask, target, offset, dataLength);
          return [target];
        }
        applyMask(data, mask, data, 0, dataLength);
        return [target, data];
      }
      /**
       * Sends a close message to the other peer.
       *
       * @param {Number} [code] The status code component of the body
       * @param {(String|Buffer)} [data] The message component of the body
       * @param {Boolean} [mask=false] Specifies whether or not to mask the message
       * @param {Function} [cb] Callback
       * @public
       */
      close(code, data, mask, cb) {
        let buf;
        if (code === void 0) {
          buf = EMPTY_BUFFER;
        } else if (typeof code !== "number" || !isValidStatusCode(code)) {
          throw new TypeError("First argument must be a valid error code number");
        } else if (data === void 0 || !data.length) {
          buf = Buffer.allocUnsafe(2);
          buf.writeUInt16BE(code, 0);
        } else {
          const length = Buffer.byteLength(data);
          if (length > 123) {
            throw new RangeError("The message must not be greater than 123 bytes");
          }
          buf = Buffer.allocUnsafe(2 + length);
          buf.writeUInt16BE(code, 0);
          if (typeof data === "string") {
            buf.write(data, 2);
          } else if (isUint8Array(data)) {
            buf.set(data, 2);
          } else {
            throw new TypeError("Second argument must be a string or a Uint8Array");
          }
        }
        const options = {
          [kByteLength]: buf.length,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 8,
          readOnly: false,
          rsv1: false
        };
        if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, buf, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(buf, options), cb);
        }
      }
      /**
       * Sends a ping message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      ping(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 9,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a pong message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Boolean} [mask=false] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback
       * @public
       */
      pong(data, mask, cb) {
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (byteLength > 125) {
          throw new RangeError("The data size must not be greater than 125 bytes");
        }
        const options = {
          [kByteLength]: byteLength,
          fin: true,
          generateMask: this._generateMask,
          mask,
          maskBuffer: this._maskBuffer,
          opcode: 10,
          readOnly,
          rsv1: false
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, false, options, cb]);
          } else {
            this.getBlobData(data, false, options, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, false, options, cb]);
        } else {
          this.sendFrame(_Sender.frame(data, options), cb);
        }
      }
      /**
       * Sends a data message to the other peer.
       *
       * @param {*} data The message to send
       * @param {Object} options Options object
       * @param {Boolean} [options.binary=false] Specifies whether `data` is binary
       *     or text
       * @param {Boolean} [options.compress=false] Specifies whether or not to
       *     compress `data`
       * @param {Boolean} [options.fin=false] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Function} [cb] Callback
       * @public
       */
      send(data, options, cb) {
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        let opcode = options.binary ? 2 : 1;
        let rsv1 = options.compress;
        let byteLength;
        let readOnly;
        if (typeof data === "string") {
          byteLength = Buffer.byteLength(data);
          readOnly = false;
        } else if (isBlob(data)) {
          byteLength = data.size;
          readOnly = false;
        } else {
          data = toBuffer(data);
          byteLength = data.length;
          readOnly = toBuffer.readOnly;
        }
        if (this._firstFragment) {
          this._firstFragment = false;
          if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) {
            rsv1 = byteLength >= perMessageDeflate._threshold;
          }
          this._compress = rsv1;
        } else {
          rsv1 = false;
          opcode = 0;
        }
        if (options.fin) this._firstFragment = true;
        const opts = {
          [kByteLength]: byteLength,
          fin: options.fin,
          generateMask: this._generateMask,
          mask: options.mask,
          maskBuffer: this._maskBuffer,
          opcode,
          readOnly,
          rsv1
        };
        if (isBlob(data)) {
          if (this._state !== DEFAULT) {
            this.enqueue([this.getBlobData, data, this._compress, opts, cb]);
          } else {
            this.getBlobData(data, this._compress, opts, cb);
          }
        } else if (this._state !== DEFAULT) {
          this.enqueue([this.dispatch, data, this._compress, opts, cb]);
        } else {
          this.dispatch(data, this._compress, opts, cb);
        }
      }
      /**
       * Gets the contents of a blob as binary data.
       *
       * @param {Blob} blob The blob
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     the data
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      getBlobData(blob, compress, options, cb) {
        this._bufferedBytes += options[kByteLength];
        this._state = GET_BLOB_DATA;
        blob.arrayBuffer().then((arrayBuffer) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while the blob was being read"
            );
            process.nextTick(callCallbacks, this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          const data = toBuffer(arrayBuffer);
          if (!compress) {
            this._state = DEFAULT;
            this.sendFrame(_Sender.frame(data, options), cb);
            this.dequeue();
          } else {
            this.dispatch(data, compress, options, cb);
          }
        }).catch((err) => {
          process.nextTick(onError, this, err, cb);
        });
      }
      /**
       * Dispatches a message.
       *
       * @param {(Buffer|String)} data The message to send
       * @param {Boolean} [compress=false] Specifies whether or not to compress
       *     `data`
       * @param {Object} options Options object
       * @param {Boolean} [options.fin=false] Specifies whether or not to set the
       *     FIN bit
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Boolean} [options.mask=false] Specifies whether or not to mask
       *     `data`
       * @param {Buffer} [options.maskBuffer] The buffer used to store the masking
       *     key
       * @param {Number} options.opcode The opcode
       * @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
       *     modified
       * @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
       *     RSV1 bit
       * @param {Function} [cb] Callback
       * @private
       */
      dispatch(data, compress, options, cb) {
        if (!compress) {
          this.sendFrame(_Sender.frame(data, options), cb);
          return;
        }
        const perMessageDeflate = this._extensions[PerMessageDeflate2.extensionName];
        this._bufferedBytes += options[kByteLength];
        this._state = DEFLATING;
        perMessageDeflate.compress(data, options.fin, (_, buf) => {
          if (this._socket.destroyed) {
            const err = new Error(
              "The socket was closed while data was being compressed"
            );
            callCallbacks(this, err, cb);
            return;
          }
          this._bufferedBytes -= options[kByteLength];
          this._state = DEFAULT;
          options.readOnly = false;
          this.sendFrame(_Sender.frame(buf, options), cb);
          this.dequeue();
        });
      }
      /**
       * Executes queued send operations.
       *
       * @private
       */
      dequeue() {
        while (this._state === DEFAULT && this._queue.length) {
          const params = this._queue.shift();
          this._bufferedBytes -= params[3][kByteLength];
          Reflect.apply(params[0], this, params.slice(1));
        }
      }
      /**
       * Enqueues a send operation.
       *
       * @param {Array} params Send operation parameters.
       * @private
       */
      enqueue(params) {
        this._bufferedBytes += params[3][kByteLength];
        this._queue.push(params);
      }
      /**
       * Sends a frame.
       *
       * @param {(Buffer | String)[]} list The frame to send
       * @param {Function} [cb] Callback
       * @private
       */
      sendFrame(list, cb) {
        if (list.length === 2) {
          this._socket.cork();
          this._socket.write(list[0]);
          this._socket.write(list[1], cb);
          this._socket.uncork();
        } else {
          this._socket.write(list[0], cb);
        }
      }
    };
    module.exports = Sender2;
    function callCallbacks(sender, err, cb) {
      if (typeof cb === "function") cb(err);
      for (let i = 0; i < sender._queue.length; i++) {
        const params = sender._queue[i];
        const callback = params[params.length - 1];
        if (typeof callback === "function") callback(err);
      }
    }
    function onError(sender, err, cb) {
      callCallbacks(sender, err, cb);
      sender.onerror(err);
    }
  }
});

// node_modules/ws/lib/event-target.js
var require_event_target = __commonJS({
  "node_modules/ws/lib/event-target.js"(exports, module) {
    "use strict";
    var { kForOnEventAttribute, kListener } = require_constants();
    var kCode = /* @__PURE__ */ Symbol("kCode");
    var kData = /* @__PURE__ */ Symbol("kData");
    var kError = /* @__PURE__ */ Symbol("kError");
    var kMessage = /* @__PURE__ */ Symbol("kMessage");
    var kReason = /* @__PURE__ */ Symbol("kReason");
    var kTarget = /* @__PURE__ */ Symbol("kTarget");
    var kType = /* @__PURE__ */ Symbol("kType");
    var kWasClean = /* @__PURE__ */ Symbol("kWasClean");
    var Event = class {
      /**
       * Create a new `Event`.
       *
       * @param {String} type The name of the event
       * @throws {TypeError} If the `type` argument is not specified
       */
      constructor(type) {
        this[kTarget] = null;
        this[kType] = type;
      }
      /**
       * @type {*}
       */
      get target() {
        return this[kTarget];
      }
      /**
       * @type {String}
       */
      get type() {
        return this[kType];
      }
    };
    Object.defineProperty(Event.prototype, "target", { enumerable: true });
    Object.defineProperty(Event.prototype, "type", { enumerable: true });
    var CloseEvent = class extends Event {
      /**
       * Create a new `CloseEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {Number} [options.code=0] The status code explaining why the
       *     connection was closed
       * @param {String} [options.reason=''] A human-readable string explaining why
       *     the connection was closed
       * @param {Boolean} [options.wasClean=false] Indicates whether or not the
       *     connection was cleanly closed
       */
      constructor(type, options = {}) {
        super(type);
        this[kCode] = options.code === void 0 ? 0 : options.code;
        this[kReason] = options.reason === void 0 ? "" : options.reason;
        this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
      }
      /**
       * @type {Number}
       */
      get code() {
        return this[kCode];
      }
      /**
       * @type {String}
       */
      get reason() {
        return this[kReason];
      }
      /**
       * @type {Boolean}
       */
      get wasClean() {
        return this[kWasClean];
      }
    };
    Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
    Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
    var ErrorEvent = class extends Event {
      /**
       * Create a new `ErrorEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.error=null] The error that generated this event
       * @param {String} [options.message=''] The error message
       */
      constructor(type, options = {}) {
        super(type);
        this[kError] = options.error === void 0 ? null : options.error;
        this[kMessage] = options.message === void 0 ? "" : options.message;
      }
      /**
       * @type {*}
       */
      get error() {
        return this[kError];
      }
      /**
       * @type {String}
       */
      get message() {
        return this[kMessage];
      }
    };
    Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
    Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
    var MessageEvent = class extends Event {
      /**
       * Create a new `MessageEvent`.
       *
       * @param {String} type The name of the event
       * @param {Object} [options] A dictionary object that allows for setting
       *     attributes via object members of the same name
       * @param {*} [options.data=null] The message content
       */
      constructor(type, options = {}) {
        super(type);
        this[kData] = options.data === void 0 ? null : options.data;
      }
      /**
       * @type {*}
       */
      get data() {
        return this[kData];
      }
    };
    Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
    var EventTarget = {
      /**
       * Register an event listener.
       *
       * @param {String} type A string representing the event type to listen for
       * @param {(Function|Object)} handler The listener to add
       * @param {Object} [options] An options object specifies characteristics about
       *     the event listener
       * @param {Boolean} [options.once=false] A `Boolean` indicating that the
       *     listener should be invoked at most once after being added. If `true`,
       *     the listener would be automatically removed when invoked.
       * @public
       */
      addEventListener(type, handler, options = {}) {
        for (const listener of this.listeners(type)) {
          if (!options[kForOnEventAttribute] && listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            return;
          }
        }
        let wrapper;
        if (type === "message") {
          wrapper = function onMessage(data, isBinary) {
            const event = new MessageEvent("message", {
              data: isBinary ? data : data.toString()
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "close") {
          wrapper = function onClose(code, message) {
            const event = new CloseEvent("close", {
              code,
              reason: message.toString(),
              wasClean: this._closeFrameReceived && this._closeFrameSent
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "error") {
          wrapper = function onError(error) {
            const event = new ErrorEvent("error", {
              error,
              message: error.message
            });
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else if (type === "open") {
          wrapper = function onOpen() {
            const event = new Event("open");
            event[kTarget] = this;
            callListener(handler, this, event);
          };
        } else {
          return;
        }
        wrapper[kForOnEventAttribute] = !!options[kForOnEventAttribute];
        wrapper[kListener] = handler;
        if (options.once) {
          this.once(type, wrapper);
        } else {
          this.on(type, wrapper);
        }
      },
      /**
       * Remove an event listener.
       *
       * @param {String} type A string representing the event type to remove
       * @param {(Function|Object)} handler The listener to remove
       * @public
       */
      removeEventListener(type, handler) {
        for (const listener of this.listeners(type)) {
          if (listener[kListener] === handler && !listener[kForOnEventAttribute]) {
            this.removeListener(type, listener);
            break;
          }
        }
      }
    };
    module.exports = {
      CloseEvent,
      ErrorEvent,
      Event,
      EventTarget,
      MessageEvent
    };
    function callListener(listener, thisArg, event) {
      if (typeof listener === "object" && listener.handleEvent) {
        listener.handleEvent.call(listener, event);
      } else {
        listener.call(thisArg, event);
      }
    }
  }
});

// node_modules/ws/lib/extension.js
var require_extension = __commonJS({
  "node_modules/ws/lib/extension.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function push(dest, name, elem) {
      if (dest[name] === void 0) dest[name] = [elem];
      else dest[name].push(elem);
    }
    function parse(header) {
      const offers = /* @__PURE__ */ Object.create(null);
      let params = /* @__PURE__ */ Object.create(null);
      let mustUnescape = false;
      let isEscaping = false;
      let inQuotes = false;
      let extensionName;
      let paramName;
      let start = -1;
      let code = -1;
      let end = -1;
      let i = 0;
      for (; i < header.length; i++) {
        code = header.charCodeAt(i);
        if (extensionName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (i !== 0 && (code === 32 || code === 9)) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            const name = header.slice(start, end);
            if (code === 44) {
              push(offers, name, params);
              params = /* @__PURE__ */ Object.create(null);
            } else {
              extensionName = name;
            }
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else if (paramName === void 0) {
          if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (code === 32 || code === 9) {
            if (end === -1 && start !== -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            push(params, header.slice(start, end), true);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            start = end = -1;
          } else if (code === 61 && start !== -1 && end === -1) {
            paramName = header.slice(start, i);
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        } else {
          if (isEscaping) {
            if (tokenChars[code] !== 1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (start === -1) start = i;
            else if (!mustUnescape) mustUnescape = true;
            isEscaping = false;
          } else if (inQuotes) {
            if (tokenChars[code] === 1) {
              if (start === -1) start = i;
            } else if (code === 34 && start !== -1) {
              inQuotes = false;
              end = i;
            } else if (code === 92) {
              isEscaping = true;
            } else {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
          } else if (code === 34 && header.charCodeAt(i - 1) === 61) {
            inQuotes = true;
          } else if (end === -1 && tokenChars[code] === 1) {
            if (start === -1) start = i;
          } else if (start !== -1 && (code === 32 || code === 9)) {
            if (end === -1) end = i;
          } else if (code === 59 || code === 44) {
            if (start === -1) {
              throw new SyntaxError(`Unexpected character at index ${i}`);
            }
            if (end === -1) end = i;
            let value = header.slice(start, end);
            if (mustUnescape) {
              value = value.replace(/\\/g, "");
              mustUnescape = false;
            }
            push(params, paramName, value);
            if (code === 44) {
              push(offers, extensionName, params);
              params = /* @__PURE__ */ Object.create(null);
              extensionName = void 0;
            }
            paramName = void 0;
            start = end = -1;
          } else {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
        }
      }
      if (start === -1 || inQuotes || code === 32 || code === 9) {
        throw new SyntaxError("Unexpected end of input");
      }
      if (end === -1) end = i;
      const token = header.slice(start, end);
      if (extensionName === void 0) {
        push(offers, token, params);
      } else {
        if (paramName === void 0) {
          push(params, token, true);
        } else if (mustUnescape) {
          push(params, paramName, token.replace(/\\/g, ""));
        } else {
          push(params, paramName, token);
        }
        push(offers, extensionName, params);
      }
      return offers;
    }
    function format(extensions) {
      return Object.keys(extensions).map((extension2) => {
        let configurations = extensions[extension2];
        if (!Array.isArray(configurations)) configurations = [configurations];
        return configurations.map((params) => {
          return [extension2].concat(
            Object.keys(params).map((k) => {
              let values = params[k];
              if (!Array.isArray(values)) values = [values];
              return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
            })
          ).join("; ");
        }).join(", ");
      }).join(", ");
    }
    module.exports = { format, parse };
  }
});

// node_modules/ws/lib/websocket.js
var require_websocket = __commonJS({
  "node_modules/ws/lib/websocket.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var https = __require("https");
    var http = __require("http");
    var net = __require("net");
    var tls = __require("tls");
    var { randomBytes: randomBytes4, createHash } = __require("crypto");
    var { Duplex, Readable } = __require("stream");
    var { URL: URL2 } = __require("url");
    var PerMessageDeflate2 = require_permessage_deflate();
    var Receiver2 = require_receiver();
    var Sender2 = require_sender();
    var { isBlob } = require_validation();
    var {
      BINARY_TYPES,
      CLOSE_TIMEOUT,
      EMPTY_BUFFER,
      GUID,
      kForOnEventAttribute,
      kListener,
      kStatusCode,
      kWebSocket,
      NOOP
    } = require_constants();
    var {
      EventTarget: { addEventListener, removeEventListener }
    } = require_event_target();
    var { format, parse } = require_extension();
    var { toBuffer } = require_buffer_util();
    var kAborted = /* @__PURE__ */ Symbol("kAborted");
    var protocolVersions = [8, 13];
    var readyStates = ["CONNECTING", "OPEN", "CLOSING", "CLOSED"];
    var subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
    var WebSocket2 = class _WebSocket extends EventEmitter {
      /**
       * Create a new `WebSocket`.
       *
       * @param {(String|URL)} address The URL to which to connect
       * @param {(String|String[])} [protocols] The subprotocols
       * @param {Object} [options] Connection options
       */
      constructor(address, protocols, options) {
        super();
        this._binaryType = BINARY_TYPES[0];
        this._closeCode = 1006;
        this._closeFrameReceived = false;
        this._closeFrameSent = false;
        this._closeMessage = EMPTY_BUFFER;
        this._closeTimer = null;
        this._errorEmitted = false;
        this._extensions = {};
        this._paused = false;
        this._protocol = "";
        this._readyState = _WebSocket.CONNECTING;
        this._receiver = null;
        this._sender = null;
        this._socket = null;
        if (address !== null) {
          this._bufferedAmount = 0;
          this._isServer = false;
          this._redirects = 0;
          if (protocols === void 0) {
            protocols = [];
          } else if (!Array.isArray(protocols)) {
            if (typeof protocols === "object" && protocols !== null) {
              options = protocols;
              protocols = [];
            } else {
              protocols = [protocols];
            }
          }
          initAsClient(this, address, protocols, options);
        } else {
          this._autoPong = options.autoPong;
          this._closeTimeout = options.closeTimeout;
          this._isServer = true;
        }
      }
      /**
       * For historical reasons, the custom "nodebuffer" type is used by the default
       * instead of "blob".
       *
       * @type {String}
       */
      get binaryType() {
        return this._binaryType;
      }
      set binaryType(type) {
        if (!BINARY_TYPES.includes(type)) return;
        this._binaryType = type;
        if (this._receiver) this._receiver._binaryType = type;
      }
      /**
       * @type {Number}
       */
      get bufferedAmount() {
        if (!this._socket) return this._bufferedAmount;
        return this._socket._writableState.length + this._sender._bufferedBytes;
      }
      /**
       * @type {String}
       */
      get extensions() {
        return Object.keys(this._extensions).join();
      }
      /**
       * @type {Boolean}
       */
      get isPaused() {
        return this._paused;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onclose() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onerror() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onopen() {
        return null;
      }
      /**
       * @type {Function}
       */
      /* istanbul ignore next */
      get onmessage() {
        return null;
      }
      /**
       * @type {String}
       */
      get protocol() {
        return this._protocol;
      }
      /**
       * @type {Number}
       */
      get readyState() {
        return this._readyState;
      }
      /**
       * @type {String}
       */
      get url() {
        return this._url;
      }
      /**
       * Set up the socket and the internal resources.
       *
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Object} options Options object
       * @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Function} [options.generateMask] The function used to generate the
       *     masking key
       * @param {Number} [options.maxBufferedChunks=0] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=0] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=0] The maximum allowed message size
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @private
       */
      setSocket(socket, head, options) {
        const receiver = new Receiver2({
          allowSynchronousEvents: options.allowSynchronousEvents,
          binaryType: this.binaryType,
          extensions: this._extensions,
          isServer: this._isServer,
          maxBufferedChunks: options.maxBufferedChunks,
          maxFragments: options.maxFragments,
          maxPayload: options.maxPayload,
          skipUTF8Validation: options.skipUTF8Validation
        });
        const sender = new Sender2(socket, this._extensions, options.generateMask);
        this._receiver = receiver;
        this._sender = sender;
        this._socket = socket;
        receiver[kWebSocket] = this;
        sender[kWebSocket] = this;
        socket[kWebSocket] = this;
        receiver.on("conclude", receiverOnConclude);
        receiver.on("drain", receiverOnDrain);
        receiver.on("error", receiverOnError);
        receiver.on("message", receiverOnMessage);
        receiver.on("ping", receiverOnPing);
        receiver.on("pong", receiverOnPong);
        sender.onerror = senderOnError;
        if (socket.setTimeout) socket.setTimeout(0);
        if (socket.setNoDelay) socket.setNoDelay();
        if (head.length > 0) socket.unshift(head);
        socket.on("close", socketOnClose);
        socket.on("data", socketOnData);
        socket.on("end", socketOnEnd);
        socket.on("error", socketOnError);
        this._readyState = _WebSocket.OPEN;
        this.emit("open");
      }
      /**
       * Emit the `'close'` event.
       *
       * @private
       */
      emitClose() {
        if (!this._socket) {
          this._readyState = _WebSocket.CLOSED;
          this.emit("close", this._closeCode, this._closeMessage);
          return;
        }
        if (this._extensions[PerMessageDeflate2.extensionName]) {
          this._extensions[PerMessageDeflate2.extensionName].cleanup();
        }
        this._receiver.removeAllListeners();
        this._readyState = _WebSocket.CLOSED;
        this.emit("close", this._closeCode, this._closeMessage);
      }
      /**
       * Start a closing handshake.
       *
       *          +----------+   +-----------+   +----------+
       *     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
       *    |     +----------+   +-----------+   +----------+     |
       *          +----------+   +-----------+         |
       * CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
       *          +----------+   +-----------+   |
       *    |           |                        |   +---+        |
       *                +------------------------+-->|fin| - - - -
       *    |         +---+                      |   +---+
       *     - - - - -|fin|<---------------------+
       *              +---+
       *
       * @param {Number} [code] Status code explaining why the connection is closing
       * @param {(String|Buffer)} [data] The reason why the connection is
       *     closing
       * @public
       */
      close(code, data) {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this.readyState === _WebSocket.CLOSING) {
          if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) {
            this._socket.end();
          }
          return;
        }
        this._readyState = _WebSocket.CLOSING;
        this._sender.close(code, data, !this._isServer, (err) => {
          if (err) return;
          this._closeFrameSent = true;
          if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) {
            this._socket.end();
          }
        });
        setCloseTimer(this);
      }
      /**
       * Pause the socket.
       *
       * @public
       */
      pause() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = true;
        this._socket.pause();
      }
      /**
       * Send a ping.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the ping is sent
       * @public
       */
      ping(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.ping(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Send a pong.
       *
       * @param {*} [data] The data to send
       * @param {Boolean} [mask] Indicates whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when the pong is sent
       * @public
       */
      pong(data, mask, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof data === "function") {
          cb = data;
          data = mask = void 0;
        } else if (typeof mask === "function") {
          cb = mask;
          mask = void 0;
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        if (mask === void 0) mask = !this._isServer;
        this._sender.pong(data || EMPTY_BUFFER, mask, cb);
      }
      /**
       * Resume the socket.
       *
       * @public
       */
      resume() {
        if (this.readyState === _WebSocket.CONNECTING || this.readyState === _WebSocket.CLOSED) {
          return;
        }
        this._paused = false;
        if (!this._receiver._writableState.needDrain) this._socket.resume();
      }
      /**
       * Send a data message.
       *
       * @param {*} data The message to send
       * @param {Object} [options] Options object
       * @param {Boolean} [options.binary] Specifies whether `data` is binary or
       *     text
       * @param {Boolean} [options.compress] Specifies whether or not to compress
       *     `data`
       * @param {Boolean} [options.fin=true] Specifies whether the fragment is the
       *     last one
       * @param {Boolean} [options.mask] Specifies whether or not to mask `data`
       * @param {Function} [cb] Callback which is executed when data is written out
       * @public
       */
      send(data, options, cb) {
        if (this.readyState === _WebSocket.CONNECTING) {
          throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
        }
        if (typeof options === "function") {
          cb = options;
          options = {};
        }
        if (typeof data === "number") data = data.toString();
        if (this.readyState !== _WebSocket.OPEN) {
          sendAfterClose(this, data, cb);
          return;
        }
        const opts = {
          binary: typeof data !== "string",
          mask: !this._isServer,
          compress: true,
          fin: true,
          ...options
        };
        if (!this._extensions[PerMessageDeflate2.extensionName]) {
          opts.compress = false;
        }
        this._sender.send(data || EMPTY_BUFFER, opts, cb);
      }
      /**
       * Forcibly close the connection.
       *
       * @public
       */
      terminate() {
        if (this.readyState === _WebSocket.CLOSED) return;
        if (this.readyState === _WebSocket.CONNECTING) {
          const msg = "WebSocket was closed before the connection was established";
          abortHandshake(this, this._req, msg);
          return;
        }
        if (this._socket) {
          this._readyState = _WebSocket.CLOSING;
          this._socket.destroy();
        }
      }
    };
    Object.defineProperty(WebSocket2, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2.prototype, "CONNECTING", {
      enumerable: true,
      value: readyStates.indexOf("CONNECTING")
    });
    Object.defineProperty(WebSocket2, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2.prototype, "OPEN", {
      enumerable: true,
      value: readyStates.indexOf("OPEN")
    });
    Object.defineProperty(WebSocket2, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSING", {
      enumerable: true,
      value: readyStates.indexOf("CLOSING")
    });
    Object.defineProperty(WebSocket2, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    Object.defineProperty(WebSocket2.prototype, "CLOSED", {
      enumerable: true,
      value: readyStates.indexOf("CLOSED")
    });
    [
      "binaryType",
      "bufferedAmount",
      "extensions",
      "isPaused",
      "protocol",
      "readyState",
      "url"
    ].forEach((property) => {
      Object.defineProperty(WebSocket2.prototype, property, { enumerable: true });
    });
    ["open", "error", "close", "message"].forEach((method) => {
      Object.defineProperty(WebSocket2.prototype, `on${method}`, {
        enumerable: true,
        get() {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) return listener[kListener];
          }
          return null;
        },
        set(handler) {
          for (const listener of this.listeners(method)) {
            if (listener[kForOnEventAttribute]) {
              this.removeListener(method, listener);
              break;
            }
          }
          if (typeof handler !== "function") return;
          this.addEventListener(method, handler, {
            [kForOnEventAttribute]: true
          });
        }
      });
    });
    WebSocket2.prototype.addEventListener = addEventListener;
    WebSocket2.prototype.removeEventListener = removeEventListener;
    module.exports = WebSocket2;
    function initAsClient(websocket, address, protocols, options) {
      const opts = {
        allowSynchronousEvents: true,
        autoPong: true,
        closeTimeout: CLOSE_TIMEOUT,
        protocolVersion: protocolVersions[1],
        maxBufferedChunks: 256 * 1024,
        maxFragments: 16 * 1024,
        maxPayload: 100 * 1024 * 1024,
        skipUTF8Validation: false,
        perMessageDeflate: true,
        followRedirects: false,
        maxRedirects: 10,
        ...options,
        socketPath: void 0,
        hostname: void 0,
        protocol: void 0,
        timeout: void 0,
        method: "GET",
        host: void 0,
        path: void 0,
        port: void 0
      };
      websocket._autoPong = opts.autoPong;
      websocket._closeTimeout = opts.closeTimeout;
      if (!protocolVersions.includes(opts.protocolVersion)) {
        throw new RangeError(
          `Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`
        );
      }
      let parsedUrl;
      if (address instanceof URL2) {
        parsedUrl = address;
      } else {
        try {
          parsedUrl = new URL2(address);
        } catch {
          throw new SyntaxError(`Invalid URL: ${address}`);
        }
      }
      if (parsedUrl.protocol === "http:") {
        parsedUrl.protocol = "ws:";
      } else if (parsedUrl.protocol === "https:") {
        parsedUrl.protocol = "wss:";
      }
      websocket._url = parsedUrl.href;
      const isSecure = parsedUrl.protocol === "wss:";
      const isIpcUrl = parsedUrl.protocol === "ws+unix:";
      let invalidUrlMessage;
      if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) {
        invalidUrlMessage = `The URL's protocol must be one of "ws:", "wss:", "http:", "https:", or "ws+unix:"`;
      } else if (isIpcUrl && !parsedUrl.pathname) {
        invalidUrlMessage = "The URL's pathname is empty";
      } else if (parsedUrl.hash) {
        invalidUrlMessage = "The URL contains a fragment identifier";
      }
      if (invalidUrlMessage) {
        const err = new SyntaxError(invalidUrlMessage);
        if (websocket._redirects === 0) {
          throw err;
        } else {
          emitErrorAndClose(websocket, err);
          return;
        }
      }
      const defaultPort = isSecure ? 443 : 80;
      const key2 = randomBytes4(16).toString("base64");
      const request = isSecure ? https.request : http.request;
      const protocolSet = /* @__PURE__ */ new Set();
      let perMessageDeflate;
      opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
      opts.defaultPort = opts.defaultPort || defaultPort;
      opts.port = parsedUrl.port || defaultPort;
      opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
      opts.headers = {
        ...opts.headers,
        "Sec-WebSocket-Version": opts.protocolVersion,
        "Sec-WebSocket-Key": key2,
        Connection: "Upgrade",
        Upgrade: "websocket"
      };
      opts.path = parsedUrl.pathname + parsedUrl.search;
      opts.timeout = opts.handshakeTimeout;
      if (opts.perMessageDeflate) {
        perMessageDeflate = new PerMessageDeflate2({
          ...opts.perMessageDeflate,
          isServer: false,
          maxPayload: opts.maxPayload
        });
        opts.headers["Sec-WebSocket-Extensions"] = format({
          [PerMessageDeflate2.extensionName]: perMessageDeflate.offer()
        });
      }
      if (protocols.length) {
        for (const protocol of protocols) {
          if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) {
            throw new SyntaxError(
              "An invalid or duplicated subprotocol was specified"
            );
          }
          protocolSet.add(protocol);
        }
        opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
      }
      if (opts.origin) {
        if (opts.protocolVersion < 13) {
          opts.headers["Sec-WebSocket-Origin"] = opts.origin;
        } else {
          opts.headers.Origin = opts.origin;
        }
      }
      if (parsedUrl.username || parsedUrl.password) {
        opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
      }
      if (isIpcUrl) {
        const parts = opts.path.split(":");
        opts.socketPath = parts[0];
        opts.path = parts[1];
      }
      let req;
      if (opts.followRedirects) {
        if (websocket._redirects === 0) {
          websocket._originalIpc = isIpcUrl;
          websocket._originalSecure = isSecure;
          websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
          const headers = options && options.headers;
          options = { ...options, headers: {} };
          if (headers) {
            for (const [key3, value] of Object.entries(headers)) {
              options.headers[key3.toLowerCase()] = value;
            }
          }
        } else if (websocket.listenerCount("redirect") === 0) {
          const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
          if (!isSameHost || websocket._originalSecure && !isSecure) {
            delete opts.headers.authorization;
            delete opts.headers.cookie;
            if (!isSameHost) delete opts.headers.host;
            opts.auth = void 0;
          }
        }
        if (opts.auth && !options.headers.authorization) {
          options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
        }
        req = websocket._req = request(opts);
        if (websocket._redirects) {
          websocket.emit("redirect", websocket.url, req);
        }
      } else {
        req = websocket._req = request(opts);
      }
      if (opts.timeout) {
        req.on("timeout", () => {
          abortHandshake(websocket, req, "Opening handshake has timed out");
        });
      }
      req.on("error", (err) => {
        if (req === null || req[kAborted]) return;
        req = websocket._req = null;
        emitErrorAndClose(websocket, err);
      });
      req.on("response", (res) => {
        const location = res.headers.location;
        const statusCode = res.statusCode;
        if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
          if (++websocket._redirects > opts.maxRedirects) {
            abortHandshake(websocket, req, "Maximum redirects exceeded");
            return;
          }
          req.abort();
          let addr;
          try {
            addr = new URL2(location, address);
          } catch (e) {
            const err = new SyntaxError(`Invalid URL: ${location}`);
            emitErrorAndClose(websocket, err);
            return;
          }
          initAsClient(websocket, addr, protocols, options);
        } else if (!websocket.emit("unexpected-response", req, res)) {
          abortHandshake(
            websocket,
            req,
            `Unexpected server response: ${res.statusCode}`
          );
        }
      });
      req.on("upgrade", (res, socket, head) => {
        websocket.emit("upgrade", res);
        if (websocket.readyState !== WebSocket2.CONNECTING) return;
        req = websocket._req = null;
        const upgrade = res.headers.upgrade;
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          abortHandshake(websocket, socket, "Invalid Upgrade header");
          return;
        }
        const digest = createHash("sha1").update(key2 + GUID).digest("base64");
        if (res.headers["sec-websocket-accept"] !== digest) {
          abortHandshake(websocket, socket, "Invalid Sec-WebSocket-Accept header");
          return;
        }
        const serverProt = res.headers["sec-websocket-protocol"];
        let protError;
        if (serverProt !== void 0) {
          if (!protocolSet.size) {
            protError = "Server sent a subprotocol but none was requested";
          } else if (!protocolSet.has(serverProt)) {
            protError = "Server sent an invalid subprotocol";
          }
        } else if (protocolSet.size) {
          protError = "Server sent no subprotocol";
        }
        if (protError) {
          abortHandshake(websocket, socket, protError);
          return;
        }
        if (serverProt) websocket._protocol = serverProt;
        const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
        if (secWebSocketExtensions !== void 0) {
          if (!perMessageDeflate) {
            const message = "Server sent a Sec-WebSocket-Extensions header but no extension was requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          let extensions;
          try {
            extensions = parse(secWebSocketExtensions);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          const extensionNames = Object.keys(extensions);
          if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate2.extensionName) {
            const message = "Server indicated an extension that was not requested";
            abortHandshake(websocket, socket, message);
            return;
          }
          try {
            perMessageDeflate.accept(extensions[PerMessageDeflate2.extensionName]);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Extensions header";
            abortHandshake(websocket, socket, message);
            return;
          }
          websocket._extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
        }
        websocket.setSocket(socket, head, {
          allowSynchronousEvents: opts.allowSynchronousEvents,
          generateMask: opts.generateMask,
          maxBufferedChunks: opts.maxBufferedChunks,
          maxFragments: opts.maxFragments,
          maxPayload: opts.maxPayload,
          skipUTF8Validation: opts.skipUTF8Validation
        });
      });
      if (opts.finishRequest) {
        opts.finishRequest(req, websocket);
      } else {
        req.end();
      }
    }
    function emitErrorAndClose(websocket, err) {
      websocket._readyState = WebSocket2.CLOSING;
      websocket._errorEmitted = true;
      websocket.emit("error", err);
      websocket.emitClose();
    }
    function netConnect(options) {
      options.path = options.socketPath;
      return net.connect(options);
    }
    function tlsConnect(options) {
      options.path = void 0;
      if (!options.servername && options.servername !== "") {
        options.servername = net.isIP(options.host) ? "" : options.host;
      }
      return tls.connect(options);
    }
    function abortHandshake(websocket, stream, message) {
      websocket._readyState = WebSocket2.CLOSING;
      const err = new Error(message);
      Error.captureStackTrace(err, abortHandshake);
      if (stream.setHeader) {
        stream[kAborted] = true;
        stream.abort();
        if (stream.socket && !stream.socket.destroyed) {
          stream.socket.destroy();
        }
        process.nextTick(emitErrorAndClose, websocket, err);
      } else {
        stream.destroy(err);
        stream.once("error", websocket.emit.bind(websocket, "error"));
        stream.once("close", websocket.emitClose.bind(websocket));
      }
    }
    function sendAfterClose(websocket, data, cb) {
      if (data) {
        const length = isBlob(data) ? data.size : toBuffer(data).length;
        if (websocket._socket) websocket._sender._bufferedBytes += length;
        else websocket._bufferedAmount += length;
      }
      if (cb) {
        const err = new Error(
          `WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`
        );
        process.nextTick(cb, err);
      }
    }
    function receiverOnConclude(code, reason) {
      const websocket = this[kWebSocket];
      websocket._closeFrameReceived = true;
      websocket._closeMessage = reason;
      websocket._closeCode = code;
      if (websocket._socket[kWebSocket] === void 0) return;
      websocket._socket.removeListener("data", socketOnData);
      process.nextTick(resume, websocket._socket);
      if (code === 1005) websocket.close();
      else websocket.close(code, reason);
    }
    function receiverOnDrain() {
      const websocket = this[kWebSocket];
      if (!websocket.isPaused) websocket._socket.resume();
    }
    function receiverOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket._socket[kWebSocket] !== void 0) {
        websocket._socket.removeListener("data", socketOnData);
        process.nextTick(resume, websocket._socket);
        websocket.close(err[kStatusCode]);
      }
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function receiverOnFinish() {
      this[kWebSocket].emitClose();
    }
    function receiverOnMessage(data, isBinary) {
      this[kWebSocket].emit("message", data, isBinary);
    }
    function receiverOnPing(data) {
      const websocket = this[kWebSocket];
      if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
      websocket.emit("ping", data);
    }
    function receiverOnPong(data) {
      this[kWebSocket].emit("pong", data);
    }
    function resume(stream) {
      stream.resume();
    }
    function senderOnError(err) {
      const websocket = this[kWebSocket];
      if (websocket.readyState === WebSocket2.CLOSED) return;
      if (websocket.readyState === WebSocket2.OPEN) {
        websocket._readyState = WebSocket2.CLOSING;
        setCloseTimer(websocket);
      }
      this._socket.end();
      if (!websocket._errorEmitted) {
        websocket._errorEmitted = true;
        websocket.emit("error", err);
      }
    }
    function setCloseTimer(websocket) {
      websocket._closeTimer = setTimeout(
        websocket._socket.destroy.bind(websocket._socket),
        websocket._closeTimeout
      );
    }
    function socketOnClose() {
      const websocket = this[kWebSocket];
      this.removeListener("close", socketOnClose);
      this.removeListener("data", socketOnData);
      this.removeListener("end", socketOnEnd);
      websocket._readyState = WebSocket2.CLOSING;
      if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
        const chunk = this.read(this._readableState.length);
        websocket._receiver.write(chunk);
      }
      websocket._receiver.end();
      this[kWebSocket] = void 0;
      clearTimeout(websocket._closeTimer);
      if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) {
        websocket.emitClose();
      } else {
        websocket._receiver.on("error", receiverOnFinish);
        websocket._receiver.on("finish", receiverOnFinish);
      }
    }
    function socketOnData(chunk) {
      if (!this[kWebSocket]._receiver.write(chunk)) {
        this.pause();
      }
    }
    function socketOnEnd() {
      const websocket = this[kWebSocket];
      websocket._readyState = WebSocket2.CLOSING;
      websocket._receiver.end();
      this.end();
    }
    function socketOnError() {
      const websocket = this[kWebSocket];
      this.removeListener("error", socketOnError);
      this.on("error", NOOP);
      if (websocket) {
        websocket._readyState = WebSocket2.CLOSING;
        this.destroy();
      }
    }
  }
});

// node_modules/ws/lib/stream.js
var require_stream = __commonJS({
  "node_modules/ws/lib/stream.js"(exports, module) {
    "use strict";
    var WebSocket2 = require_websocket();
    var { Duplex } = __require("stream");
    function emitClose(stream) {
      stream.emit("close");
    }
    function duplexOnEnd() {
      if (!this.destroyed && this._writableState.finished) {
        this.destroy();
      }
    }
    function duplexOnError(err) {
      this.removeListener("error", duplexOnError);
      this.destroy();
      if (this.listenerCount("error") === 0) {
        this.emit("error", err);
      }
    }
    function createWebSocketStream2(ws, options) {
      let terminateOnDestroy = true;
      const duplex = new Duplex({
        ...options,
        autoDestroy: false,
        emitClose: false,
        objectMode: false,
        writableObjectMode: false
      });
      ws.on("message", function message(msg, isBinary) {
        const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
        if (!duplex.push(data)) ws.pause();
      });
      ws.once("error", function error(err) {
        if (duplex.destroyed) return;
        terminateOnDestroy = false;
        duplex.destroy(err);
      });
      ws.once("close", function close() {
        if (duplex.destroyed) return;
        duplex.push(null);
      });
      duplex._destroy = function(err, callback) {
        if (ws.readyState === ws.CLOSED) {
          callback(err);
          process.nextTick(emitClose, duplex);
          return;
        }
        let called = false;
        ws.once("error", function error(err2) {
          called = true;
          callback(err2);
        });
        ws.once("close", function close() {
          if (!called) callback(err);
          process.nextTick(emitClose, duplex);
        });
        if (terminateOnDestroy) ws.terminate();
      };
      duplex._final = function(callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._final(callback);
          });
          return;
        }
        if (ws._socket === null) return;
        if (ws._socket._writableState.finished) {
          callback();
          if (duplex._readableState.endEmitted) duplex.destroy();
        } else {
          ws._socket.once("finish", function finish() {
            callback();
          });
          ws.close();
        }
      };
      duplex._read = function() {
        if (ws.isPaused) ws.resume();
      };
      duplex._write = function(chunk, encoding, callback) {
        if (ws.readyState === ws.CONNECTING) {
          ws.once("open", function open() {
            duplex._write(chunk, encoding, callback);
          });
          return;
        }
        ws.send(chunk, callback);
      };
      duplex.on("end", duplexOnEnd);
      duplex.on("error", duplexOnError);
      return duplex;
    }
    module.exports = createWebSocketStream2;
  }
});

// node_modules/ws/lib/subprotocol.js
var require_subprotocol = __commonJS({
  "node_modules/ws/lib/subprotocol.js"(exports, module) {
    "use strict";
    var { tokenChars } = require_validation();
    function parse(header) {
      const protocols = /* @__PURE__ */ new Set();
      let start = -1;
      let end = -1;
      let i = 0;
      for (i; i < header.length; i++) {
        const code = header.charCodeAt(i);
        if (end === -1 && tokenChars[code] === 1) {
          if (start === -1) start = i;
        } else if (i !== 0 && (code === 32 || code === 9)) {
          if (end === -1 && start !== -1) end = i;
        } else if (code === 44) {
          if (start === -1) {
            throw new SyntaxError(`Unexpected character at index ${i}`);
          }
          if (end === -1) end = i;
          const protocol2 = header.slice(start, end);
          if (protocols.has(protocol2)) {
            throw new SyntaxError(`The "${protocol2}" subprotocol is duplicated`);
          }
          protocols.add(protocol2);
          start = end = -1;
        } else {
          throw new SyntaxError(`Unexpected character at index ${i}`);
        }
      }
      if (start === -1 || end !== -1) {
        throw new SyntaxError("Unexpected end of input");
      }
      const protocol = header.slice(start, i);
      if (protocols.has(protocol)) {
        throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
      }
      protocols.add(protocol);
      return protocols;
    }
    module.exports = { parse };
  }
});

// node_modules/ws/lib/websocket-server.js
var require_websocket_server = __commonJS({
  "node_modules/ws/lib/websocket-server.js"(exports, module) {
    "use strict";
    var EventEmitter = __require("events");
    var http = __require("http");
    var { Duplex } = __require("stream");
    var { createHash } = __require("crypto");
    var extension2 = require_extension();
    var PerMessageDeflate2 = require_permessage_deflate();
    var subprotocol2 = require_subprotocol();
    var WebSocket2 = require_websocket();
    var { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
    var keyRegex = /^[+/0-9A-Za-z]{22}==$/;
    var RUNNING = 0;
    var CLOSING = 1;
    var CLOSED = 2;
    var WebSocketServer2 = class extends EventEmitter {
      /**
       * Create a `WebSocketServer` instance.
       *
       * @param {Object} options Configuration options
       * @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
       *     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
       *     multiple times in the same tick
       * @param {Boolean} [options.autoPong=true] Specifies whether or not to
       *     automatically send a pong in response to a ping
       * @param {Number} [options.backlog=511] The maximum length of the queue of
       *     pending connections
       * @param {Boolean} [options.clientTracking=true] Specifies whether or not to
       *     track clients
       * @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
       *     wait for the closing handshake to finish after `websocket.close()` is
       *     called
       * @param {Function} [options.handleProtocols] A hook to handle protocols
       * @param {String} [options.host] The hostname where to bind the server
       * @param {Number} [options.maxBufferedChunks=262144] The maximum number of
       *     buffered data chunks
       * @param {Number} [options.maxFragments=16384] The maximum number of message
       *     fragments
       * @param {Number} [options.maxPayload=104857600] The maximum allowed message
       *     size
       * @param {Boolean} [options.noServer=false] Enable no server mode
       * @param {String} [options.path] Accept only connections matching this path
       * @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
       *     permessage-deflate
       * @param {Number} [options.port] The port where to bind the server
       * @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
       *     server to use
       * @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
       *     not to skip UTF-8 validation for text and close messages
       * @param {Function} [options.verifyClient] A hook to reject connections
       * @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
       *     class to use. It must be the `WebSocket` class or class that extends it
       * @param {Function} [callback] A listener for the `listening` event
       */
      constructor(options, callback) {
        super();
        options = {
          allowSynchronousEvents: true,
          autoPong: true,
          maxBufferedChunks: 256 * 1024,
          maxFragments: 16 * 1024,
          maxPayload: 100 * 1024 * 1024,
          skipUTF8Validation: false,
          perMessageDeflate: false,
          handleProtocols: null,
          clientTracking: true,
          closeTimeout: CLOSE_TIMEOUT,
          verifyClient: null,
          noServer: false,
          backlog: null,
          // use default (511 as implemented in net.js)
          server: null,
          host: null,
          path: null,
          port: null,
          WebSocket: WebSocket2,
          ...options
        };
        if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) {
          throw new TypeError(
            'One and only one of the "port", "server", or "noServer" options must be specified'
          );
        }
        if (options.port != null) {
          this._server = http.createServer((req, res) => {
            const body = http.STATUS_CODES[426];
            res.writeHead(426, {
              "Content-Length": body.length,
              "Content-Type": "text/plain"
            });
            res.end(body);
          });
          this._server.listen(
            options.port,
            options.host,
            options.backlog,
            callback
          );
        } else if (options.server) {
          this._server = options.server;
        }
        if (this._server) {
          const emitConnection = this.emit.bind(this, "connection");
          this._removeListeners = addListeners(this._server, {
            listening: this.emit.bind(this, "listening"),
            error: this.emit.bind(this, "error"),
            upgrade: (req, socket, head) => {
              this.handleUpgrade(req, socket, head, emitConnection);
            }
          });
        }
        if (options.perMessageDeflate === true) options.perMessageDeflate = {};
        if (options.clientTracking) {
          this.clients = /* @__PURE__ */ new Set();
          this._shouldEmitClose = false;
        }
        this.options = options;
        this._state = RUNNING;
      }
      /**
       * Returns the bound address, the address family name, and port of the server
       * as reported by the operating system if listening on an IP socket.
       * If the server is listening on a pipe or UNIX domain socket, the name is
       * returned as a string.
       *
       * @return {(Object|String|null)} The address of the server
       * @public
       */
      address() {
        if (this.options.noServer) {
          throw new Error('The server is operating in "noServer" mode');
        }
        if (!this._server) return null;
        return this._server.address();
      }
      /**
       * Stop the server from accepting new connections and emit the `'close'` event
       * when all existing connections are closed.
       *
       * @param {Function} [cb] A one-time listener for the `'close'` event
       * @public
       */
      close(cb) {
        if (this._state === CLOSED) {
          if (cb) {
            this.once("close", () => {
              cb(new Error("The server is not running"));
            });
          }
          process.nextTick(emitClose, this);
          return;
        }
        if (cb) this.once("close", cb);
        if (this._state === CLOSING) return;
        this._state = CLOSING;
        if (this.options.noServer || this.options.server) {
          if (this._server) {
            this._removeListeners();
            this._removeListeners = this._server = null;
          }
          if (this.clients) {
            if (!this.clients.size) {
              process.nextTick(emitClose, this);
            } else {
              this._shouldEmitClose = true;
            }
          } else {
            process.nextTick(emitClose, this);
          }
        } else {
          const server = this._server;
          this._removeListeners();
          this._removeListeners = this._server = null;
          server.close(() => {
            emitClose(this);
          });
        }
      }
      /**
       * See if a given request should be handled by this server instance.
       *
       * @param {http.IncomingMessage} req Request object to inspect
       * @return {Boolean} `true` if the request is valid, else `false`
       * @public
       */
      shouldHandle(req) {
        if (this.options.path) {
          const index = req.url.indexOf("?");
          const pathname = index !== -1 ? req.url.slice(0, index) : req.url;
          if (pathname !== this.options.path) return false;
        }
        return true;
      }
      /**
       * Handle a HTTP Upgrade request.
       *
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @public
       */
      handleUpgrade(req, socket, head, cb) {
        socket.on("error", socketOnError);
        const key2 = req.headers["sec-websocket-key"];
        const upgrade = req.headers.upgrade;
        const version = +req.headers["sec-websocket-version"];
        if (req.method !== "GET") {
          const message = "Invalid HTTP method";
          abortHandshakeOrEmitwsClientError(this, req, socket, 405, message);
          return;
        }
        if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
          const message = "Invalid Upgrade header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (key2 === void 0 || !keyRegex.test(key2)) {
          const message = "Missing or invalid Sec-WebSocket-Key header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
          return;
        }
        if (version !== 13 && version !== 8) {
          const message = "Missing or invalid Sec-WebSocket-Version header";
          abortHandshakeOrEmitwsClientError(this, req, socket, 400, message, {
            "Sec-WebSocket-Version": "13, 8"
          });
          return;
        }
        if (!this.shouldHandle(req)) {
          abortHandshake(socket, 400);
          return;
        }
        const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
        let protocols = /* @__PURE__ */ new Set();
        if (secWebSocketProtocol !== void 0) {
          try {
            protocols = subprotocol2.parse(secWebSocketProtocol);
          } catch (err) {
            const message = "Invalid Sec-WebSocket-Protocol header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
        const extensions = {};
        if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
          const perMessageDeflate = new PerMessageDeflate2({
            ...this.options.perMessageDeflate,
            isServer: true,
            maxPayload: this.options.maxPayload
          });
          try {
            const offers = extension2.parse(secWebSocketExtensions);
            if (offers[PerMessageDeflate2.extensionName]) {
              perMessageDeflate.accept(offers[PerMessageDeflate2.extensionName]);
              extensions[PerMessageDeflate2.extensionName] = perMessageDeflate;
            }
          } catch (err) {
            const message = "Invalid or unacceptable Sec-WebSocket-Extensions header";
            abortHandshakeOrEmitwsClientError(this, req, socket, 400, message);
            return;
          }
        }
        if (this.options.verifyClient) {
          const info = {
            origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
            secure: !!(req.socket.authorized || req.socket.encrypted),
            req
          };
          if (this.options.verifyClient.length === 2) {
            this.options.verifyClient(info, (verified, code, message, headers) => {
              if (!verified) {
                return abortHandshake(socket, code || 401, message, headers);
              }
              this.completeUpgrade(
                extensions,
                key2,
                protocols,
                req,
                socket,
                head,
                cb
              );
            });
            return;
          }
          if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
        }
        this.completeUpgrade(extensions, key2, protocols, req, socket, head, cb);
      }
      /**
       * Upgrade the connection to WebSocket.
       *
       * @param {Object} extensions The accepted extensions
       * @param {String} key The value of the `Sec-WebSocket-Key` header
       * @param {Set} protocols The subprotocols
       * @param {http.IncomingMessage} req The request object
       * @param {Duplex} socket The network socket between the server and client
       * @param {Buffer} head The first packet of the upgraded stream
       * @param {Function} cb Callback
       * @throws {Error} If called more than once with the same socket
       * @private
       */
      completeUpgrade(extensions, key2, protocols, req, socket, head, cb) {
        if (!socket.readable || !socket.writable) return socket.destroy();
        if (socket[kWebSocket]) {
          throw new Error(
            "server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration"
          );
        }
        if (this._state > RUNNING) return abortHandshake(socket, 503);
        const digest = createHash("sha1").update(key2 + GUID).digest("base64");
        const headers = [
          "HTTP/1.1 101 Switching Protocols",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Accept: ${digest}`
        ];
        const ws = new this.options.WebSocket(null, void 0, this.options);
        if (protocols.size) {
          const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
          if (protocol) {
            headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
            ws._protocol = protocol;
          }
        }
        if (extensions[PerMessageDeflate2.extensionName]) {
          const params = extensions[PerMessageDeflate2.extensionName].params;
          const value = extension2.format({
            [PerMessageDeflate2.extensionName]: [params]
          });
          headers.push(`Sec-WebSocket-Extensions: ${value}`);
          ws._extensions = extensions;
        }
        this.emit("headers", headers, req);
        socket.write(headers.concat("\r\n").join("\r\n"));
        socket.removeListener("error", socketOnError);
        ws.setSocket(socket, head, {
          allowSynchronousEvents: this.options.allowSynchronousEvents,
          maxBufferedChunks: this.options.maxBufferedChunks,
          maxFragments: this.options.maxFragments,
          maxPayload: this.options.maxPayload,
          skipUTF8Validation: this.options.skipUTF8Validation
        });
        if (this.clients) {
          this.clients.add(ws);
          ws.on("close", () => {
            this.clients.delete(ws);
            if (this._shouldEmitClose && !this.clients.size) {
              process.nextTick(emitClose, this);
            }
          });
        }
        cb(ws, req);
      }
    };
    module.exports = WebSocketServer2;
    function addListeners(server, map) {
      for (const event of Object.keys(map)) server.on(event, map[event]);
      return function removeListeners() {
        for (const event of Object.keys(map)) {
          server.removeListener(event, map[event]);
        }
      };
    }
    function emitClose(server) {
      server._state = CLOSED;
      server.emit("close");
    }
    function socketOnError() {
      this.destroy();
    }
    function abortHandshake(socket, code, message, headers) {
      message = message || http.STATUS_CODES[code];
      headers = {
        Connection: "close",
        "Content-Type": "text/html",
        "Content-Length": Buffer.byteLength(message),
        ...headers
      };
      socket.once("finish", socket.destroy);
      socket.end(
        `HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r
` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message
      );
    }
    function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
      if (server.listenerCount("wsClientError")) {
        const err = new Error(message);
        Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
        server.emit("wsClientError", err, socket, req);
      } else {
        abortHandshake(socket, code, message, headers);
      }
    }
  }
});

// apps/executor/src/main.ts
import { join as join3 } from "node:path";

// apps/executor/src/config.ts
import { join, resolve } from "node:path";
var DEFAULT_ORIGINS = ["https://valuedeskapp.vercel.app", "https://valuexplorer.vercel.app", "http://localhost:5180", "http://127.0.0.1:5180"];
var ADDRESS = /^0x[0-9a-fA-F]{40}$/;
function loadConfig(env = process.env) {
  const kind = env.EXECUTOR_KIND === "hosted" ? "hosted" : "self";
  const port = Number(env.PORT ?? 8799);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error(`PORT must be a port number (got ${env.PORT})`);
  const owner = env.EXECUTOR_OWNER?.trim() || null;
  if (owner && !ADDRESS.test(owner)) throw new Error("EXECUTOR_OWNER must be a 0x wallet address");
  const network = env.SODEX_NETWORK === "testnet" ? "testnet" : "mainnet";
  const builderId = Number(env.EXECUTOR_BUILDER_ID ?? 221909);
  if (!Number.isSafeInteger(builderId) || builderId < 0) throw new Error("EXECUTOR_BUILDER_ID must be a SoDEX account id (or 0 for none)");
  const ttl = Number(env.EXECUTOR_KEY_TTL_DAYS ?? 90);
  const level = env.LOG_LEVEL;
  return {
    kind,
    host: env.HOST?.trim() || "127.0.0.1",
    port,
    dataDir: resolve(env.EXECUTOR_DATA_DIR?.trim() || (kind === "hosted" ? "/var/lib/valuescan/executor" : join(process.cwd(), "copier-data"))),
    network,
    builderId,
    owner: owner ? owner.toLowerCase() : null,
    allowedOrigins: env.EXECUTOR_ALLOWED_ORIGINS?.split(",").map((s) => s.trim()).filter(Boolean) ?? DEFAULT_ORIGINS,
    location: env.EXECUTOR_LOCATION?.trim() || (kind === "hosted" ? "ap-northeast-1 (Tokyo)" : "your own machine"),
    originSecrets: [env.EXECUTOR_ORIGIN_SECRET, env.EXECUTOR_ORIGIN_SECRET_2].map((s) => s?.trim() ?? "").filter(Boolean),
    trustEdge: env.EXECUTOR_TRUST_EDGE === "1",
    open: env.EXECUTOR_OPEN !== "0",
    // 90 days is what the copy terms promise and what the web app registers at most.
    keyTtlDaysMax: Number.isFinite(ttl) && ttl >= 1 ? Math.min(Math.floor(ttl), 90) : 90,
    maxCopiesPerOwner: Math.max(1, Math.min(50, Number(env.EXECUTOR_MAX_COPIES ?? 10) || 10)),
    maxAlgosPerOwner: Math.max(1, Math.min(100, Number(env.EXECUTOR_MAX_ALGOS ?? 20) || 20)),
    builderDb: env.EXECUTOR_BUILDER_DB?.trim() || null,
    localAddress: env.EXECUTOR_LOCAL_ADDRESS?.trim() || null,
    logLevel: level === "debug" || level === "warn" || level === "error" ? level : "info"
  };
}

// apps/executor/src/net.ts
import { Agent, request as httpsRequest } from "node:https";
import { isIPv6 } from "node:net";

// node_modules/ws/wrapper.mjs
var import_stream = __toESM(require_stream(), 1);
var import_extension = __toESM(require_extension(), 1);
var import_permessage_deflate = __toESM(require_permessage_deflate(), 1);
var import_receiver = __toESM(require_receiver(), 1);
var import_sender = __toESM(require_sender(), 1);
var import_subprotocol = __toESM(require_subprotocol(), 1);
var import_websocket = __toESM(require_websocket(), 1);
var import_websocket_server = __toESM(require_websocket_server(), 1);
var wrapper_default = import_websocket.default;

// apps/executor/src/net.ts
function egress(localAddress) {
  if (!localAddress) {
    return {
      fetch,
      factory: (url) => new globalThis.WebSocket(url),
      localAddress: null
    };
  }
  const family = isIPv6(localAddress) ? 6 : 4;
  const agent = new Agent({ keepAlive: true, localAddress, family, maxSockets: 64 });
  const bound2 = (url, init) => new Promise((resolve2, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      reject(new TypeError(`only https is allowed from the executor's own address (${u.protocol})`));
      return;
    }
    const req = httpsRequest(u, { method: init?.method ?? "GET", headers: init?.headers, agent, family }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const status = res.statusCode ?? 0;
        const body = Buffer.concat(chunks).toString("utf8");
        resolve2({ status, ok: status >= 200 && status < 300, text: async () => body });
      });
      res.on("error", reject);
    });
    const signal = init?.signal;
    if (signal?.aborted) req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" }));
    signal?.addEventListener?.("abort", () => req.destroy(Object.assign(new Error("aborted"), { name: "AbortError" })));
    req.on("error", (e) => reject(e.name === "AbortError" ? e : Object.assign(new TypeError(`fetch failed: ${e.message}`), { cause: e })));
    if (init?.body !== void 0) req.write(init.body);
    req.end();
  });
  const factory = (url) => {
    const ws = new wrapper_default(url, { localAddress, family, perMessageDeflate: false });
    const like = ws;
    return new Proxy(like, {
      set(target, prop, value) {
        if (prop === "onmessage" && typeof value === "function") {
          target.onmessage = (ev) => value({ data: typeof ev.data === "string" ? ev.data : String(ev.data) });
          return true;
        }
        target[prop] = value;
        return true;
      }
    });
  };
  return { fetch: bound2, factory, localAddress };
}

// apps/executor/src/db.ts
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
var SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS subs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS subs_owner ON subs (owner);
CREATE TABLE IF NOT EXISTS states (sub_id TEXT PRIMARY KEY, json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, sub_id TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS activity_sub ON activity (sub_id, at);
CREATE INDEX IF NOT EXISTS activity_owner ON activity (owner, at);
CREATE TABLE IF NOT EXISTS keys (
  owner TEXT NOT NULL,
  slot TEXT NOT NULL,
  address TEXT NOT NULL,
  name TEXT NOT NULL,
  sealed TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  registered INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER,
  PRIMARY KEY (owner, slot)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS terms (owner TEXT PRIMARY KEY, json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS consents (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  owner TEXT NOT NULL,
  action TEXT NOT NULL,
  digest TEXT NOT NULL UNIQUE,
  signature TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  payload TEXT NOT NULL,
  nonce TEXT NOT NULL,
  at INTEGER NOT NULL,
  viewer_country TEXT
);
CREATE INDEX IF NOT EXISTS consents_owner ON consents (owner, at);
CREATE TABLE IF NOT EXISTS algos (id TEXT PRIMARY KEY, owner TEXT NOT NULL, json TEXT NOT NULL, updated_at INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS algos_owner ON algos (owner);
CREATE TABLE IF NOT EXISTS algo_events (id TEXT PRIMARY KEY, algo_id TEXT NOT NULL, owner TEXT NOT NULL, at INTEGER NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS algo_events_algo ON algo_events (algo_id, at);
`;
var ExecutorDb = class {
  constructor(path) {
    this.path = path;
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA busy_timeout = 5000");
    this.db.exec(SCHEMA);
  }
  path;
  db;
  stmts = /* @__PURE__ */ new Map();
  close() {
    this.db.close();
  }
  q(sql) {
    let s = this.stmts.get(sql);
    if (!s) this.stmts.set(sql, s = this.db.prepare(sql));
    return s;
  }
  /* ----------------------------------------------------------- meta ----- */
  meta(k) {
    const r = this.q("SELECT v FROM meta WHERE k = ?").get(k);
    return r ? String(r.v) : null;
  }
  setMeta(k, v) {
    this.q("INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v").run(k, v);
  }
  /* ------------------------------------------------------ CopyStore ----- */
  async subscriptions() {
    return this.q("SELECT json FROM subs").all().map((r) => JSON.parse(String(r.json)));
  }
  async subscription(id) {
    const r = this.q("SELECT json FROM subs WHERE id = ?").get(id);
    return r ? JSON.parse(String(r.json)) : null;
  }
  async saveSubscription(s) {
    this.q("INSERT INTO subs (id, owner, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(
      s.id,
      s.owner,
      JSON.stringify(s),
      Date.now()
    );
  }
  async state(subId) {
    const r = this.q("SELECT json FROM states WHERE sub_id = ?").get(subId);
    return r ? JSON.parse(String(r.json)) : null;
  }
  async saveState(s) {
    this.q("INSERT INTO states (sub_id, json, updated_at) VALUES (?, ?, ?) ON CONFLICT (sub_id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(
      s.subId,
      JSON.stringify(s),
      Date.now()
    );
  }
  async addActivity(e) {
    this.q("INSERT OR IGNORE INTO activity (id, sub_id, owner, at, json) VALUES (?, ?, ?, ?, ?)").run(e.id, e.subId, e.owner, e.at, JSON.stringify(e));
  }
  async activity(q) {
    const limit = Math.max(1, Math.min(1e3, q.limit ?? 200));
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const rows2 = q.subId ? this.q("SELECT json FROM activity WHERE sub_id = ? AND at < ? ORDER BY at DESC LIMIT ?").all(q.subId, before, limit) : this.q("SELECT json FROM activity WHERE owner = ? AND at < ? ORDER BY at DESC LIMIT ?").all(q.owner ?? "", before, limit);
    return rows2.map((r) => JSON.parse(String(r.json)));
  }
  /** Activity (copies' and algos') older than `days` goes; the books keep their totals. */
  pruneActivity(days, now = Date.now()) {
    const r = this.q("DELETE FROM activity WHERE at < ?").run(now - days * 864e5);
    const e = this.q("DELETE FROM algo_events WHERE at < ?").run(now - days * 864e5);
    return Number(r.changes) + Number(e.changes);
  }
  /* ------------------------------------------------------ AlgoStore ----- */
  async algos() {
    return this.q("SELECT json FROM algos").all().map((r) => JSON.parse(String(r.json)));
  }
  async saveAlgo(a) {
    this.q("INSERT INTO algos (id, owner, json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at").run(
      a.id,
      a.owner,
      JSON.stringify(a),
      Date.now()
    );
  }
  async addAlgoEvent(e) {
    this.q("INSERT OR IGNORE INTO algo_events (id, algo_id, owner, at, json) VALUES (?, ?, ?, ?, ?)").run(e.id, e.algoId, e.owner, e.at, JSON.stringify(e));
  }
  async algoEvents(q) {
    const limit = Math.max(1, Math.min(1e3, q.limit ?? 200));
    const before = q.before ?? Number.MAX_SAFE_INTEGER;
    const rows2 = q.algoId ? this.q("SELECT json FROM algo_events WHERE algo_id = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?").all(q.algoId, before, limit) : this.q("SELECT json FROM algo_events WHERE owner = ? AND at < ? ORDER BY at DESC, id DESC LIMIT ?").all(q.owner ?? "", before, limit);
    return rows2.map((r) => JSON.parse(String(r.json)));
  }
  /* ----------------------------------------------------------- keys ----- */
  key(owner, slot) {
    const r = this.q("SELECT * FROM keys WHERE owner = ? AND slot = ?").get(owner, slot);
    return r ? keyOf(r) : null;
  }
  putKey(k) {
    this.q(
      `INSERT INTO keys (owner, slot, address, name, sealed, created_at, expires_at, registered, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner, slot) DO UPDATE SET address = excluded.address, name = excluded.name, sealed = excluded.sealed, created_at = excluded.created_at,
         expires_at = excluded.expires_at, registered = excluded.registered, checked_at = excluded.checked_at`
    ).run(k.owner, k.slot, k.address, k.name, k.sealed, k.createdAt, k.expiresAt, k.registered ? 1 : 0, k.checkedAt);
  }
  markKey(owner, slot, registered, expiresAt, checkedAt) {
    this.q("UPDATE keys SET registered = ?, expires_at = ?, checked_at = ? WHERE owner = ? AND slot = ?").run(registered ? 1 : 0, expiresAt, checkedAt, owner, slot);
  }
  /** The pending key becomes the active one (it was registered on SoDEX). */
  promoteKey(owner) {
    this.db.exec("BEGIN");
    try {
      this.q("DELETE FROM keys WHERE owner = ? AND slot = 'active'").run(owner);
      this.q("UPDATE keys SET slot = 'active' WHERE owner = ? AND slot = 'pending'").run(owner);
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  deleteKeys(owner) {
    this.q("DELETE FROM keys WHERE owner = ?").run(owner);
  }
  /* ---------------------------------------------------------- terms ----- */
  terms(owner) {
    const r = this.q("SELECT json FROM terms WHERE owner = ?").get(owner);
    return r ? JSON.parse(String(r.json)) : null;
  }
  setTerms(owner, t) {
    this.q("INSERT INTO terms (owner, json) VALUES (?, ?) ON CONFLICT (owner) DO UPDATE SET json = excluded.json").run(owner, JSON.stringify(t));
  }
  /* ------------------------------------------------------- consents ----- */
  /** Record a signed request. False when this exact request was already used (a replay). */
  addConsent(c) {
    try {
      this.q("INSERT INTO consents (owner, action, digest, signature, chain_id, payload, nonce, at, viewer_country) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
        c.owner,
        c.action,
        c.digest,
        c.signature,
        c.chainId,
        c.payload,
        c.nonce,
        c.at,
        c.viewerCountry
      );
      return true;
    } catch (e) {
      if (/UNIQUE/i.test(String(e))) return false;
      throw e;
    }
  }
  consents(owner, limit = 200) {
    return this.q("SELECT * FROM consents WHERE owner = ? ORDER BY seq DESC LIMIT ?").all(owner, limit).map((r) => ({
      owner: String(r.owner),
      action: String(r.action),
      digest: String(r.digest),
      signature: String(r.signature),
      chainId: Number(r.chain_id),
      payload: String(r.payload),
      nonce: String(r.nonce),
      at: Number(r.at),
      viewerCountry: r.viewer_country === null ? null : String(r.viewer_country)
    }));
  }
};
function keyOf(r) {
  return {
    owner: String(r.owner),
    slot: r.slot === "pending" ? "pending" : "active",
    address: String(r.address),
    name: String(r.name),
    sealed: String(r.sealed),
    createdAt: Number(r.created_at),
    expiresAt: r.expires_at === null || r.expires_at === void 0 ? null : Number(r.expires_at),
    registered: Number(r.registered) === 1,
    checkedAt: r.checked_at === null || r.checked_at === void 0 ? null : Number(r.checked_at)
  };
}

// apps/executor/src/secrets.ts
import { createCipheriv, createDecipheriv, createHmac, randomBytes as randomBytes2, timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "node:fs";
import { join as join2 } from "node:path";

// packages/sodex-core/src/network.ts
var ENGINES = ["spot", "perps"];
var SODEX_CHAIN_ID = {
  mainnet: 286623,
  testnet: 138565
};
var GATEWAY_ORIGIN = {
  mainnet: "https://mainnet-gw.sodex.dev",
  testnet: "https://testnet-gw.sodex.dev"
};
var GATEWAY_WS_ORIGIN = {
  mainnet: "wss://mainnet-gw.sodex.dev",
  testnet: "wss://testnet-gw.sodex.dev"
};
var DEFAULT_RELAY_BASE = "/sodex";
var enginePath = (engine) => `/api/v1/${engine}`;
var DomainName = { spot: "spot", perps: "futures", universal: "universal" };
var engineDomainName = (engine) => engine === "spot" ? DomainName.spot : DomainName.perps;

// node_modules/@noble/hashes/esm/_u64.js
var U32_MASK64 = /* @__PURE__ */ BigInt(2 ** 32 - 1);
var _32n = /* @__PURE__ */ BigInt(32);
function fromBig(n, le = false) {
  if (le)
    return { h: Number(n & U32_MASK64), l: Number(n >> _32n & U32_MASK64) };
  return { h: Number(n >> _32n & U32_MASK64) | 0, l: Number(n & U32_MASK64) | 0 };
}
function split(lst, le = false) {
  const len = lst.length;
  let Ah = new Uint32Array(len);
  let Al = new Uint32Array(len);
  for (let i = 0; i < len; i++) {
    const { h, l } = fromBig(lst[i], le);
    [Ah[i], Al[i]] = [h, l];
  }
  return [Ah, Al];
}
var rotlSH = (h, l, s) => h << s | l >>> 32 - s;
var rotlSL = (h, l, s) => l << s | h >>> 32 - s;
var rotlBH = (h, l, s) => l << s - 32 | h >>> 64 - s;
var rotlBL = (h, l, s) => h << s - 32 | l >>> 64 - s;

// node_modules/@noble/hashes/esm/utils.js
function isBytes(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function anumber(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function abytes(b, ...lengths) {
  if (!isBytes(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function aexists(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput(out, instance) {
  abytes(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}
function u32(arr) {
  return new Uint32Array(arr.buffer, arr.byteOffset, Math.floor(arr.byteLength / 4));
}
function clean(...arrays) {
  for (let i = 0; i < arrays.length; i++) {
    arrays[i].fill(0);
  }
}
var isLE = /* @__PURE__ */ (() => new Uint8Array(new Uint32Array([287454020]).buffer)[0] === 68)();
function byteSwap(word2) {
  return word2 << 24 & 4278190080 | word2 << 8 & 16711680 | word2 >>> 8 & 65280 | word2 >>> 24 & 255;
}
function byteSwap32(arr) {
  for (let i = 0; i < arr.length; i++) {
    arr[i] = byteSwap(arr[i]);
  }
  return arr;
}
var swap32IfBE = isLE ? (u) => u : byteSwap32;
function utf8ToBytes(str2) {
  if (typeof str2 !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str2));
}
function toBytes(data) {
  if (typeof data === "string")
    data = utf8ToBytes(data);
  abytes(data);
  return data;
}
var Hash = class {
};
function createHasher(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}

// node_modules/@noble/hashes/esm/sha3.js
var _0n = BigInt(0);
var _1n = BigInt(1);
var _2n = BigInt(2);
var _7n = BigInt(7);
var _256n = BigInt(256);
var _0x71n = BigInt(113);
var SHA3_PI = [];
var SHA3_ROTL = [];
var _SHA3_IOTA = [];
for (let round = 0, R = _1n, x = 1, y = 0; round < 24; round++) {
  [x, y] = [y, (2 * x + 3 * y) % 5];
  SHA3_PI.push(2 * (5 * y + x));
  SHA3_ROTL.push((round + 1) * (round + 2) / 2 % 64);
  let t = _0n;
  for (let j = 0; j < 7; j++) {
    R = (R << _1n ^ (R >> _7n) * _0x71n) % _256n;
    if (R & _2n)
      t ^= _1n << (_1n << /* @__PURE__ */ BigInt(j)) - _1n;
  }
  _SHA3_IOTA.push(t);
}
var IOTAS = split(_SHA3_IOTA, true);
var SHA3_IOTA_H = IOTAS[0];
var SHA3_IOTA_L = IOTAS[1];
var rotlH = (h, l, s) => s > 32 ? rotlBH(h, l, s) : rotlSH(h, l, s);
var rotlL = (h, l, s) => s > 32 ? rotlBL(h, l, s) : rotlSL(h, l, s);
function keccakP(s, rounds = 24) {
  const B = new Uint32Array(5 * 2);
  for (let round = 24 - rounds; round < 24; round++) {
    for (let x = 0; x < 10; x++)
      B[x] = s[x] ^ s[x + 10] ^ s[x + 20] ^ s[x + 30] ^ s[x + 40];
    for (let x = 0; x < 10; x += 2) {
      const idx1 = (x + 8) % 10;
      const idx0 = (x + 2) % 10;
      const B0 = B[idx0];
      const B1 = B[idx0 + 1];
      const Th = rotlH(B0, B1, 1) ^ B[idx1];
      const Tl = rotlL(B0, B1, 1) ^ B[idx1 + 1];
      for (let y = 0; y < 50; y += 10) {
        s[x + y] ^= Th;
        s[x + y + 1] ^= Tl;
      }
    }
    let curH = s[2];
    let curL = s[3];
    for (let t = 0; t < 24; t++) {
      const shift = SHA3_ROTL[t];
      const Th = rotlH(curH, curL, shift);
      const Tl = rotlL(curH, curL, shift);
      const PI = SHA3_PI[t];
      curH = s[PI];
      curL = s[PI + 1];
      s[PI] = Th;
      s[PI + 1] = Tl;
    }
    for (let y = 0; y < 50; y += 10) {
      for (let x = 0; x < 10; x++)
        B[x] = s[y + x];
      for (let x = 0; x < 10; x++)
        s[y + x] ^= ~B[(x + 2) % 10] & B[(x + 4) % 10];
    }
    s[0] ^= SHA3_IOTA_H[round];
    s[1] ^= SHA3_IOTA_L[round];
  }
  clean(B);
}
var Keccak = class _Keccak extends Hash {
  // NOTE: we accept arguments in bytes instead of bits here.
  constructor(blockLen, suffix, outputLen, enableXOF = false, rounds = 24) {
    super();
    this.pos = 0;
    this.posOut = 0;
    this.finished = false;
    this.destroyed = false;
    this.enableXOF = false;
    this.blockLen = blockLen;
    this.suffix = suffix;
    this.outputLen = outputLen;
    this.enableXOF = enableXOF;
    this.rounds = rounds;
    anumber(outputLen);
    if (!(0 < blockLen && blockLen < 200))
      throw new Error("only keccak-f1600 function is supported");
    this.state = new Uint8Array(200);
    this.state32 = u32(this.state);
  }
  clone() {
    return this._cloneInto();
  }
  keccak() {
    swap32IfBE(this.state32);
    keccakP(this.state32, this.rounds);
    swap32IfBE(this.state32);
    this.posOut = 0;
    this.pos = 0;
  }
  update(data) {
    aexists(this);
    data = toBytes(data);
    abytes(data);
    const { blockLen, state } = this;
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      for (let i = 0; i < take; i++)
        state[this.pos++] ^= data[pos++];
      if (this.pos === blockLen)
        this.keccak();
    }
    return this;
  }
  finish() {
    if (this.finished)
      return;
    this.finished = true;
    const { state, suffix, pos, blockLen } = this;
    state[pos] ^= suffix;
    if ((suffix & 128) !== 0 && pos === blockLen - 1)
      this.keccak();
    state[blockLen - 1] ^= 128;
    this.keccak();
  }
  writeInto(out) {
    aexists(this, false);
    abytes(out);
    this.finish();
    const bufferOut = this.state;
    const { blockLen } = this;
    for (let pos = 0, len = out.length; pos < len; ) {
      if (this.posOut >= blockLen)
        this.keccak();
      const take = Math.min(blockLen - this.posOut, len - pos);
      out.set(bufferOut.subarray(this.posOut, this.posOut + take), pos);
      this.posOut += take;
      pos += take;
    }
    return out;
  }
  xofInto(out) {
    if (!this.enableXOF)
      throw new Error("XOF is not possible for this instance");
    return this.writeInto(out);
  }
  xof(bytes) {
    anumber(bytes);
    return this.xofInto(new Uint8Array(bytes));
  }
  digestInto(out) {
    aoutput(out, this);
    if (this.finished)
      throw new Error("digest() was already called");
    this.writeInto(out);
    this.destroy();
    return out;
  }
  digest() {
    return this.digestInto(new Uint8Array(this.outputLen));
  }
  destroy() {
    this.destroyed = true;
    clean(this.state);
  }
  _cloneInto(to) {
    const { blockLen, suffix, outputLen, rounds, enableXOF } = this;
    to || (to = new _Keccak(blockLen, suffix, outputLen, enableXOF, rounds));
    to.state32.set(this.state32);
    to.pos = this.pos;
    to.posOut = this.posOut;
    to.finished = this.finished;
    to.rounds = rounds;
    to.suffix = suffix;
    to.outputLen = outputLen;
    to.enableXOF = enableXOF;
    to.destroyed = this.destroyed;
    return to;
  }
};
var gen = (suffix, blockLen, outputLen) => createHasher(() => new Keccak(blockLen, suffix, outputLen));
var keccak_256 = /* @__PURE__ */ (() => gen(1, 136, 256 / 8))();

// node_modules/@noble/curves/node_modules/@noble/hashes/esm/_assert.js
function anumber2(n) {
  if (!Number.isSafeInteger(n) || n < 0)
    throw new Error("positive integer expected, got " + n);
}
function isBytes2(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes2(b, ...lengths) {
  if (!isBytes2(b))
    throw new Error("Uint8Array expected");
  if (lengths.length > 0 && !lengths.includes(b.length))
    throw new Error("Uint8Array expected of length " + lengths + ", got length=" + b.length);
}
function ahash(h) {
  if (typeof h !== "function" || typeof h.create !== "function")
    throw new Error("Hash should be wrapped by utils.wrapConstructor");
  anumber2(h.outputLen);
  anumber2(h.blockLen);
}
function aexists2(instance, checkFinished = true) {
  if (instance.destroyed)
    throw new Error("Hash instance has been destroyed");
  if (checkFinished && instance.finished)
    throw new Error("Hash#digest() has already been called");
}
function aoutput2(out, instance) {
  abytes2(out);
  const min = instance.outputLen;
  if (out.length < min) {
    throw new Error("digestInto() expects output buffer of length at least " + min);
  }
}

// node_modules/@noble/curves/node_modules/@noble/hashes/esm/cryptoNode.js
import * as nc from "node:crypto";
var crypto = nc && typeof nc === "object" && "webcrypto" in nc ? nc.webcrypto : nc && typeof nc === "object" && "randomBytes" in nc ? nc : void 0;

// node_modules/@noble/curves/node_modules/@noble/hashes/esm/utils.js
var createView = (arr) => new DataView(arr.buffer, arr.byteOffset, arr.byteLength);
var rotr = (word2, shift) => word2 << 32 - shift | word2 >>> shift;
function utf8ToBytes2(str2) {
  if (typeof str2 !== "string")
    throw new Error("utf8ToBytes expected string, got " + typeof str2);
  return new Uint8Array(new TextEncoder().encode(str2));
}
function toBytes2(data) {
  if (typeof data === "string")
    data = utf8ToBytes2(data);
  abytes2(data);
  return data;
}
function concatBytes(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes2(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
var Hash2 = class {
  // Safe version that clones internal state
  clone() {
    return this._cloneInto();
  }
};
function wrapConstructor(hashCons) {
  const hashC = (msg) => hashCons().update(toBytes2(msg)).digest();
  const tmp = hashCons();
  hashC.outputLen = tmp.outputLen;
  hashC.blockLen = tmp.blockLen;
  hashC.create = () => hashCons();
  return hashC;
}
function randomBytes(bytesLength = 32) {
  if (crypto && typeof crypto.getRandomValues === "function") {
    return crypto.getRandomValues(new Uint8Array(bytesLength));
  }
  if (crypto && typeof crypto.randomBytes === "function") {
    return crypto.randomBytes(bytesLength);
  }
  throw new Error("crypto.getRandomValues must be defined");
}

// node_modules/@noble/curves/node_modules/@noble/hashes/esm/_md.js
function setBigUint64(view, byteOffset, value, isLE2) {
  if (typeof view.setBigUint64 === "function")
    return view.setBigUint64(byteOffset, value, isLE2);
  const _32n2 = BigInt(32);
  const _u32_max = BigInt(4294967295);
  const wh = Number(value >> _32n2 & _u32_max);
  const wl = Number(value & _u32_max);
  const h = isLE2 ? 4 : 0;
  const l = isLE2 ? 0 : 4;
  view.setUint32(byteOffset + h, wh, isLE2);
  view.setUint32(byteOffset + l, wl, isLE2);
}
var Chi = (a, b, c) => a & b ^ ~a & c;
var Maj = (a, b, c) => a & b ^ a & c ^ b & c;
var HashMD = class extends Hash2 {
  constructor(blockLen, outputLen, padOffset, isLE2) {
    super();
    this.blockLen = blockLen;
    this.outputLen = outputLen;
    this.padOffset = padOffset;
    this.isLE = isLE2;
    this.finished = false;
    this.length = 0;
    this.pos = 0;
    this.destroyed = false;
    this.buffer = new Uint8Array(blockLen);
    this.view = createView(this.buffer);
  }
  update(data) {
    aexists2(this);
    const { view, buffer, blockLen } = this;
    data = toBytes2(data);
    const len = data.length;
    for (let pos = 0; pos < len; ) {
      const take = Math.min(blockLen - this.pos, len - pos);
      if (take === blockLen) {
        const dataView = createView(data);
        for (; blockLen <= len - pos; pos += blockLen)
          this.process(dataView, pos);
        continue;
      }
      buffer.set(data.subarray(pos, pos + take), this.pos);
      this.pos += take;
      pos += take;
      if (this.pos === blockLen) {
        this.process(view, 0);
        this.pos = 0;
      }
    }
    this.length += data.length;
    this.roundClean();
    return this;
  }
  digestInto(out) {
    aexists2(this);
    aoutput2(out, this);
    this.finished = true;
    const { buffer, view, blockLen, isLE: isLE2 } = this;
    let { pos } = this;
    buffer[pos++] = 128;
    this.buffer.subarray(pos).fill(0);
    if (this.padOffset > blockLen - pos) {
      this.process(view, 0);
      pos = 0;
    }
    for (let i = pos; i < blockLen; i++)
      buffer[i] = 0;
    setBigUint64(view, blockLen - 8, BigInt(this.length * 8), isLE2);
    this.process(view, 0);
    const oview = createView(out);
    const len = this.outputLen;
    if (len % 4)
      throw new Error("_sha2: outputLen should be aligned to 32bit");
    const outLen = len / 4;
    const state = this.get();
    if (outLen > state.length)
      throw new Error("_sha2: outputLen bigger than state");
    for (let i = 0; i < outLen; i++)
      oview.setUint32(4 * i, state[i], isLE2);
  }
  digest() {
    const { buffer, outputLen } = this;
    this.digestInto(buffer);
    const res = buffer.slice(0, outputLen);
    this.destroy();
    return res;
  }
  _cloneInto(to) {
    to || (to = new this.constructor());
    to.set(...this.get());
    const { blockLen, buffer, length, finished, destroyed, pos } = this;
    to.length = length;
    to.pos = pos;
    to.finished = finished;
    to.destroyed = destroyed;
    if (length % blockLen)
      to.buffer.set(buffer);
    return to;
  }
};

// node_modules/@noble/curves/node_modules/@noble/hashes/esm/sha256.js
var SHA256_K = /* @__PURE__ */ new Uint32Array([
  1116352408,
  1899447441,
  3049323471,
  3921009573,
  961987163,
  1508970993,
  2453635748,
  2870763221,
  3624381080,
  310598401,
  607225278,
  1426881987,
  1925078388,
  2162078206,
  2614888103,
  3248222580,
  3835390401,
  4022224774,
  264347078,
  604807628,
  770255983,
  1249150122,
  1555081692,
  1996064986,
  2554220882,
  2821834349,
  2952996808,
  3210313671,
  3336571891,
  3584528711,
  113926993,
  338241895,
  666307205,
  773529912,
  1294757372,
  1396182291,
  1695183700,
  1986661051,
  2177026350,
  2456956037,
  2730485921,
  2820302411,
  3259730800,
  3345764771,
  3516065817,
  3600352804,
  4094571909,
  275423344,
  430227734,
  506948616,
  659060556,
  883997877,
  958139571,
  1322822218,
  1537002063,
  1747873779,
  1955562222,
  2024104815,
  2227730452,
  2361852424,
  2428436474,
  2756734187,
  3204031479,
  3329325298
]);
var SHA256_IV = /* @__PURE__ */ new Uint32Array([
  1779033703,
  3144134277,
  1013904242,
  2773480762,
  1359893119,
  2600822924,
  528734635,
  1541459225
]);
var SHA256_W = /* @__PURE__ */ new Uint32Array(64);
var SHA256 = class extends HashMD {
  constructor() {
    super(64, 32, 8, false);
    this.A = SHA256_IV[0] | 0;
    this.B = SHA256_IV[1] | 0;
    this.C = SHA256_IV[2] | 0;
    this.D = SHA256_IV[3] | 0;
    this.E = SHA256_IV[4] | 0;
    this.F = SHA256_IV[5] | 0;
    this.G = SHA256_IV[6] | 0;
    this.H = SHA256_IV[7] | 0;
  }
  get() {
    const { A, B, C, D, E, F, G, H } = this;
    return [A, B, C, D, E, F, G, H];
  }
  // prettier-ignore
  set(A, B, C, D, E, F, G, H) {
    this.A = A | 0;
    this.B = B | 0;
    this.C = C | 0;
    this.D = D | 0;
    this.E = E | 0;
    this.F = F | 0;
    this.G = G | 0;
    this.H = H | 0;
  }
  process(view, offset) {
    for (let i = 0; i < 16; i++, offset += 4)
      SHA256_W[i] = view.getUint32(offset, false);
    for (let i = 16; i < 64; i++) {
      const W15 = SHA256_W[i - 15];
      const W2 = SHA256_W[i - 2];
      const s0 = rotr(W15, 7) ^ rotr(W15, 18) ^ W15 >>> 3;
      const s1 = rotr(W2, 17) ^ rotr(W2, 19) ^ W2 >>> 10;
      SHA256_W[i] = s1 + SHA256_W[i - 7] + s0 + SHA256_W[i - 16] | 0;
    }
    let { A, B, C, D, E, F, G, H } = this;
    for (let i = 0; i < 64; i++) {
      const sigma1 = rotr(E, 6) ^ rotr(E, 11) ^ rotr(E, 25);
      const T1 = H + sigma1 + Chi(E, F, G) + SHA256_K[i] + SHA256_W[i] | 0;
      const sigma0 = rotr(A, 2) ^ rotr(A, 13) ^ rotr(A, 22);
      const T2 = sigma0 + Maj(A, B, C) | 0;
      H = G;
      G = F;
      F = E;
      E = D + T1 | 0;
      D = C;
      C = B;
      B = A;
      A = T1 + T2 | 0;
    }
    A = A + this.A | 0;
    B = B + this.B | 0;
    C = C + this.C | 0;
    D = D + this.D | 0;
    E = E + this.E | 0;
    F = F + this.F | 0;
    G = G + this.G | 0;
    H = H + this.H | 0;
    this.set(A, B, C, D, E, F, G, H);
  }
  roundClean() {
    SHA256_W.fill(0);
  }
  destroy() {
    this.set(0, 0, 0, 0, 0, 0, 0, 0);
    this.buffer.fill(0);
  }
};
var sha256 = /* @__PURE__ */ wrapConstructor(() => new SHA256());

// node_modules/@noble/curves/node_modules/@noble/hashes/esm/hmac.js
var HMAC = class extends Hash2 {
  constructor(hash, _key) {
    super();
    this.finished = false;
    this.destroyed = false;
    ahash(hash);
    const key2 = toBytes2(_key);
    this.iHash = hash.create();
    if (typeof this.iHash.update !== "function")
      throw new Error("Expected instance of class which extends utils.Hash");
    this.blockLen = this.iHash.blockLen;
    this.outputLen = this.iHash.outputLen;
    const blockLen = this.blockLen;
    const pad = new Uint8Array(blockLen);
    pad.set(key2.length > blockLen ? hash.create().update(key2).digest() : key2);
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54;
    this.iHash.update(pad);
    this.oHash = hash.create();
    for (let i = 0; i < pad.length; i++)
      pad[i] ^= 54 ^ 92;
    this.oHash.update(pad);
    pad.fill(0);
  }
  update(buf) {
    aexists2(this);
    this.iHash.update(buf);
    return this;
  }
  digestInto(out) {
    aexists2(this);
    abytes2(out, this.outputLen);
    this.finished = true;
    this.iHash.digestInto(out);
    this.oHash.update(out);
    this.oHash.digestInto(out);
    this.destroy();
  }
  digest() {
    const out = new Uint8Array(this.oHash.outputLen);
    this.digestInto(out);
    return out;
  }
  _cloneInto(to) {
    to || (to = Object.create(Object.getPrototypeOf(this), {}));
    const { oHash, iHash, finished, destroyed, blockLen, outputLen } = this;
    to = to;
    to.finished = finished;
    to.destroyed = destroyed;
    to.blockLen = blockLen;
    to.outputLen = outputLen;
    to.oHash = oHash._cloneInto(to.oHash);
    to.iHash = iHash._cloneInto(to.iHash);
    return to;
  }
  destroy() {
    this.destroyed = true;
    this.oHash.destroy();
    this.iHash.destroy();
  }
};
var hmac = (hash, key2, message) => new HMAC(hash, key2).update(message).digest();
hmac.create = (hash, key2) => new HMAC(hash, key2);

// node_modules/@noble/curves/esm/abstract/utils.js
var utils_exports = {};
__export(utils_exports, {
  aInRange: () => aInRange,
  abool: () => abool,
  abytes: () => abytes3,
  bitGet: () => bitGet,
  bitLen: () => bitLen,
  bitMask: () => bitMask,
  bitSet: () => bitSet,
  bytesToHex: () => bytesToHex,
  bytesToNumberBE: () => bytesToNumberBE,
  bytesToNumberLE: () => bytesToNumberLE,
  concatBytes: () => concatBytes2,
  createHmacDrbg: () => createHmacDrbg,
  ensureBytes: () => ensureBytes,
  equalBytes: () => equalBytes,
  hexToBytes: () => hexToBytes,
  hexToNumber: () => hexToNumber,
  inRange: () => inRange,
  isBytes: () => isBytes3,
  memoized: () => memoized,
  notImplemented: () => notImplemented,
  numberToBytesBE: () => numberToBytesBE,
  numberToBytesLE: () => numberToBytesLE,
  numberToHexUnpadded: () => numberToHexUnpadded,
  numberToVarBytesBE: () => numberToVarBytesBE,
  utf8ToBytes: () => utf8ToBytes3,
  validateObject: () => validateObject
});
var _0n2 = /* @__PURE__ */ BigInt(0);
var _1n2 = /* @__PURE__ */ BigInt(1);
var _2n2 = /* @__PURE__ */ BigInt(2);
function isBytes3(a) {
  return a instanceof Uint8Array || ArrayBuffer.isView(a) && a.constructor.name === "Uint8Array";
}
function abytes3(item) {
  if (!isBytes3(item))
    throw new Error("Uint8Array expected");
}
function abool(title, value) {
  if (typeof value !== "boolean")
    throw new Error(title + " boolean expected, got " + value);
}
var hexes = /* @__PURE__ */ Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
function bytesToHex(bytes) {
  abytes3(bytes);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) {
    hex += hexes[bytes[i]];
  }
  return hex;
}
function numberToHexUnpadded(num3) {
  const hex = num3.toString(16);
  return hex.length & 1 ? "0" + hex : hex;
}
function hexToNumber(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  return hex === "" ? _0n2 : BigInt("0x" + hex);
}
var asciis = { _0: 48, _9: 57, A: 65, F: 70, a: 97, f: 102 };
function asciiToBase16(ch) {
  if (ch >= asciis._0 && ch <= asciis._9)
    return ch - asciis._0;
  if (ch >= asciis.A && ch <= asciis.F)
    return ch - (asciis.A - 10);
  if (ch >= asciis.a && ch <= asciis.f)
    return ch - (asciis.a - 10);
  return;
}
function hexToBytes(hex) {
  if (typeof hex !== "string")
    throw new Error("hex string expected, got " + typeof hex);
  const hl = hex.length;
  const al = hl / 2;
  if (hl % 2)
    throw new Error("hex string expected, got unpadded hex of length " + hl);
  const array = new Uint8Array(al);
  for (let ai = 0, hi = 0; ai < al; ai++, hi += 2) {
    const n1 = asciiToBase16(hex.charCodeAt(hi));
    const n2 = asciiToBase16(hex.charCodeAt(hi + 1));
    if (n1 === void 0 || n2 === void 0) {
      const char = hex[hi] + hex[hi + 1];
      throw new Error('hex string expected, got non-hex character "' + char + '" at index ' + hi);
    }
    array[ai] = n1 * 16 + n2;
  }
  return array;
}
function bytesToNumberBE(bytes) {
  return hexToNumber(bytesToHex(bytes));
}
function bytesToNumberLE(bytes) {
  abytes3(bytes);
  return hexToNumber(bytesToHex(Uint8Array.from(bytes).reverse()));
}
function numberToBytesBE(n, len) {
  return hexToBytes(n.toString(16).padStart(len * 2, "0"));
}
function numberToBytesLE(n, len) {
  return numberToBytesBE(n, len).reverse();
}
function numberToVarBytesBE(n) {
  return hexToBytes(numberToHexUnpadded(n));
}
function ensureBytes(title, hex, expectedLength) {
  let res;
  if (typeof hex === "string") {
    try {
      res = hexToBytes(hex);
    } catch (e) {
      throw new Error(title + " must be hex string or Uint8Array, cause: " + e);
    }
  } else if (isBytes3(hex)) {
    res = Uint8Array.from(hex);
  } else {
    throw new Error(title + " must be hex string or Uint8Array");
  }
  const len = res.length;
  if (typeof expectedLength === "number" && len !== expectedLength)
    throw new Error(title + " of length " + expectedLength + " expected, got " + len);
  return res;
}
function concatBytes2(...arrays) {
  let sum = 0;
  for (let i = 0; i < arrays.length; i++) {
    const a = arrays[i];
    abytes3(a);
    sum += a.length;
  }
  const res = new Uint8Array(sum);
  for (let i = 0, pad = 0; i < arrays.length; i++) {
    const a = arrays[i];
    res.set(a, pad);
    pad += a.length;
  }
  return res;
}
function equalBytes(a, b) {
  if (a.length !== b.length)
    return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++)
    diff |= a[i] ^ b[i];
  return diff === 0;
}
function utf8ToBytes3(str2) {
  if (typeof str2 !== "string")
    throw new Error("string expected");
  return new Uint8Array(new TextEncoder().encode(str2));
}
var isPosBig = (n) => typeof n === "bigint" && _0n2 <= n;
function inRange(n, min, max) {
  return isPosBig(n) && isPosBig(min) && isPosBig(max) && min <= n && n < max;
}
function aInRange(title, n, min, max) {
  if (!inRange(n, min, max))
    throw new Error("expected valid " + title + ": " + min + " <= n < " + max + ", got " + n);
}
function bitLen(n) {
  let len;
  for (len = 0; n > _0n2; n >>= _1n2, len += 1)
    ;
  return len;
}
function bitGet(n, pos) {
  return n >> BigInt(pos) & _1n2;
}
function bitSet(n, pos, value) {
  return n | (value ? _1n2 : _0n2) << BigInt(pos);
}
var bitMask = (n) => (_2n2 << BigInt(n - 1)) - _1n2;
var u8n = (data) => new Uint8Array(data);
var u8fr = (arr) => Uint8Array.from(arr);
function createHmacDrbg(hashLen, qByteLen, hmacFn) {
  if (typeof hashLen !== "number" || hashLen < 2)
    throw new Error("hashLen must be a number");
  if (typeof qByteLen !== "number" || qByteLen < 2)
    throw new Error("qByteLen must be a number");
  if (typeof hmacFn !== "function")
    throw new Error("hmacFn must be a function");
  let v = u8n(hashLen);
  let k = u8n(hashLen);
  let i = 0;
  const reset = () => {
    v.fill(1);
    k.fill(0);
    i = 0;
  };
  const h = (...b) => hmacFn(k, v, ...b);
  const reseed = (seed = u8n()) => {
    k = h(u8fr([0]), seed);
    v = h();
    if (seed.length === 0)
      return;
    k = h(u8fr([1]), seed);
    v = h();
  };
  const gen2 = () => {
    if (i++ >= 1e3)
      throw new Error("drbg: tried 1000 values");
    let len = 0;
    const out = [];
    while (len < qByteLen) {
      v = h();
      const sl = v.slice();
      out.push(sl);
      len += v.length;
    }
    return concatBytes2(...out);
  };
  const genUntil = (seed, pred) => {
    reset();
    reseed(seed);
    let res = void 0;
    while (!(res = pred(gen2())))
      reseed();
    reset();
    return res;
  };
  return genUntil;
}
var validatorFns = {
  bigint: (val) => typeof val === "bigint",
  function: (val) => typeof val === "function",
  boolean: (val) => typeof val === "boolean",
  string: (val) => typeof val === "string",
  stringOrUint8Array: (val) => typeof val === "string" || isBytes3(val),
  isSafeInteger: (val) => Number.isSafeInteger(val),
  array: (val) => Array.isArray(val),
  field: (val, object) => object.Fp.isValid(val),
  hash: (val) => typeof val === "function" && Number.isSafeInteger(val.outputLen)
};
function validateObject(object, validators, optValidators = {}) {
  const checkField = (fieldName, type, isOptional) => {
    const checkVal = validatorFns[type];
    if (typeof checkVal !== "function")
      throw new Error("invalid validator function");
    const val = object[fieldName];
    if (isOptional && val === void 0)
      return;
    if (!checkVal(val, object)) {
      throw new Error("param " + String(fieldName) + " is invalid. Expected " + type + ", got " + val);
    }
  };
  for (const [fieldName, type] of Object.entries(validators))
    checkField(fieldName, type, false);
  for (const [fieldName, type] of Object.entries(optValidators))
    checkField(fieldName, type, true);
  return object;
}
var notImplemented = () => {
  throw new Error("not implemented");
};
function memoized(fn) {
  const map = /* @__PURE__ */ new WeakMap();
  return (arg, ...args) => {
    const val = map.get(arg);
    if (val !== void 0)
      return val;
    const computed = fn(arg, ...args);
    map.set(arg, computed);
    return computed;
  };
}

// node_modules/@noble/curves/esm/abstract/modular.js
var _0n3 = BigInt(0);
var _1n3 = BigInt(1);
var _2n3 = /* @__PURE__ */ BigInt(2);
var _3n = /* @__PURE__ */ BigInt(3);
var _4n = /* @__PURE__ */ BigInt(4);
var _5n = /* @__PURE__ */ BigInt(5);
var _8n = /* @__PURE__ */ BigInt(8);
var _9n = /* @__PURE__ */ BigInt(9);
var _16n = /* @__PURE__ */ BigInt(16);
function mod(a, b) {
  const result = a % b;
  return result >= _0n3 ? result : b + result;
}
function pow(num3, power, modulo) {
  if (power < _0n3)
    throw new Error("invalid exponent, negatives unsupported");
  if (modulo <= _0n3)
    throw new Error("invalid modulus");
  if (modulo === _1n3)
    return _0n3;
  let res = _1n3;
  while (power > _0n3) {
    if (power & _1n3)
      res = res * num3 % modulo;
    num3 = num3 * num3 % modulo;
    power >>= _1n3;
  }
  return res;
}
function pow2(x, power, modulo) {
  let res = x;
  while (power-- > _0n3) {
    res *= res;
    res %= modulo;
  }
  return res;
}
function invert(number, modulo) {
  if (number === _0n3)
    throw new Error("invert: expected non-zero number");
  if (modulo <= _0n3)
    throw new Error("invert: expected positive modulus, got " + modulo);
  let a = mod(number, modulo);
  let b = modulo;
  let x = _0n3, y = _1n3, u = _1n3, v = _0n3;
  while (a !== _0n3) {
    const q = b / a;
    const r = b % a;
    const m = x - u * q;
    const n = y - v * q;
    b = a, a = r, x = u, y = v, u = m, v = n;
  }
  const gcd = b;
  if (gcd !== _1n3)
    throw new Error("invert: does not exist");
  return mod(x, modulo);
}
function tonelliShanks(P) {
  const legendreC = (P - _1n3) / _2n3;
  let Q, S, Z;
  for (Q = P - _1n3, S = 0; Q % _2n3 === _0n3; Q /= _2n3, S++)
    ;
  for (Z = _2n3; Z < P && pow(Z, legendreC, P) !== P - _1n3; Z++) {
    if (Z > 1e3)
      throw new Error("Cannot find square root: likely non-prime P");
  }
  if (S === 1) {
    const p1div4 = (P + _1n3) / _4n;
    return function tonelliFast(Fp, n) {
      const root = Fp.pow(n, p1div4);
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
      return root;
    };
  }
  const Q1div2 = (Q + _1n3) / _2n3;
  return function tonelliSlow(Fp, n) {
    if (Fp.pow(n, legendreC) === Fp.neg(Fp.ONE))
      throw new Error("Cannot find square root");
    let r = S;
    let g = Fp.pow(Fp.mul(Fp.ONE, Z), Q);
    let x = Fp.pow(n, Q1div2);
    let b = Fp.pow(n, Q);
    while (!Fp.eql(b, Fp.ONE)) {
      if (Fp.eql(b, Fp.ZERO))
        return Fp.ZERO;
      let m = 1;
      for (let t2 = Fp.sqr(b); m < r; m++) {
        if (Fp.eql(t2, Fp.ONE))
          break;
        t2 = Fp.sqr(t2);
      }
      const ge = Fp.pow(g, _1n3 << BigInt(r - m - 1));
      g = Fp.sqr(ge);
      x = Fp.mul(x, ge);
      b = Fp.mul(b, g);
      r = m;
    }
    return x;
  };
}
function FpSqrt(P) {
  if (P % _4n === _3n) {
    const p1div4 = (P + _1n3) / _4n;
    return function sqrt3mod4(Fp, n) {
      const root = Fp.pow(n, p1div4);
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
      return root;
    };
  }
  if (P % _8n === _5n) {
    const c1 = (P - _5n) / _8n;
    return function sqrt5mod8(Fp, n) {
      const n2 = Fp.mul(n, _2n3);
      const v = Fp.pow(n2, c1);
      const nv = Fp.mul(n, v);
      const i = Fp.mul(Fp.mul(nv, _2n3), v);
      const root = Fp.mul(nv, Fp.sub(i, Fp.ONE));
      if (!Fp.eql(Fp.sqr(root), n))
        throw new Error("Cannot find square root");
      return root;
    };
  }
  if (P % _16n === _9n) {
  }
  return tonelliShanks(P);
}
var FIELD_FIELDS = [
  "create",
  "isValid",
  "is0",
  "neg",
  "inv",
  "sqrt",
  "sqr",
  "eql",
  "add",
  "sub",
  "mul",
  "pow",
  "div",
  "addN",
  "subN",
  "mulN",
  "sqrN"
];
function validateField(field) {
  const initial = {
    ORDER: "bigint",
    MASK: "bigint",
    BYTES: "isSafeInteger",
    BITS: "isSafeInteger"
  };
  const opts = FIELD_FIELDS.reduce((map, val) => {
    map[val] = "function";
    return map;
  }, initial);
  return validateObject(field, opts);
}
function FpPow(f, num3, power) {
  if (power < _0n3)
    throw new Error("invalid exponent, negatives unsupported");
  if (power === _0n3)
    return f.ONE;
  if (power === _1n3)
    return num3;
  let p = f.ONE;
  let d = num3;
  while (power > _0n3) {
    if (power & _1n3)
      p = f.mul(p, d);
    d = f.sqr(d);
    power >>= _1n3;
  }
  return p;
}
function FpInvertBatch(f, nums) {
  const tmp = new Array(nums.length);
  const lastMultiplied = nums.reduce((acc, num3, i) => {
    if (f.is0(num3))
      return acc;
    tmp[i] = acc;
    return f.mul(acc, num3);
  }, f.ONE);
  const inverted = f.inv(lastMultiplied);
  nums.reduceRight((acc, num3, i) => {
    if (f.is0(num3))
      return acc;
    tmp[i] = f.mul(acc, tmp[i]);
    return f.mul(acc, num3);
  }, inverted);
  return tmp;
}
function nLength(n, nBitLength) {
  const _nBitLength = nBitLength !== void 0 ? nBitLength : n.toString(2).length;
  const nByteLength = Math.ceil(_nBitLength / 8);
  return { nBitLength: _nBitLength, nByteLength };
}
function Field(ORDER, bitLen2, isLE2 = false, redef = {}) {
  if (ORDER <= _0n3)
    throw new Error("invalid field: expected ORDER > 0, got " + ORDER);
  const { nBitLength: BITS, nByteLength: BYTES } = nLength(ORDER, bitLen2);
  if (BYTES > 2048)
    throw new Error("invalid field: expected ORDER of <= 2048 bytes");
  let sqrtP;
  const f = Object.freeze({
    ORDER,
    isLE: isLE2,
    BITS,
    BYTES,
    MASK: bitMask(BITS),
    ZERO: _0n3,
    ONE: _1n3,
    create: (num3) => mod(num3, ORDER),
    isValid: (num3) => {
      if (typeof num3 !== "bigint")
        throw new Error("invalid field element: expected bigint, got " + typeof num3);
      return _0n3 <= num3 && num3 < ORDER;
    },
    is0: (num3) => num3 === _0n3,
    isOdd: (num3) => (num3 & _1n3) === _1n3,
    neg: (num3) => mod(-num3, ORDER),
    eql: (lhs, rhs) => lhs === rhs,
    sqr: (num3) => mod(num3 * num3, ORDER),
    add: (lhs, rhs) => mod(lhs + rhs, ORDER),
    sub: (lhs, rhs) => mod(lhs - rhs, ORDER),
    mul: (lhs, rhs) => mod(lhs * rhs, ORDER),
    pow: (num3, power) => FpPow(f, num3, power),
    div: (lhs, rhs) => mod(lhs * invert(rhs, ORDER), ORDER),
    // Same as above, but doesn't normalize
    sqrN: (num3) => num3 * num3,
    addN: (lhs, rhs) => lhs + rhs,
    subN: (lhs, rhs) => lhs - rhs,
    mulN: (lhs, rhs) => lhs * rhs,
    inv: (num3) => invert(num3, ORDER),
    sqrt: redef.sqrt || ((n) => {
      if (!sqrtP)
        sqrtP = FpSqrt(ORDER);
      return sqrtP(f, n);
    }),
    invertBatch: (lst) => FpInvertBatch(f, lst),
    // TODO: do we really need constant cmov?
    // We don't have const-time bigints anyway, so probably will be not very useful
    cmov: (a, b, c) => c ? b : a,
    toBytes: (num3) => isLE2 ? numberToBytesLE(num3, BYTES) : numberToBytesBE(num3, BYTES),
    fromBytes: (bytes) => {
      if (bytes.length !== BYTES)
        throw new Error("Field.fromBytes: expected " + BYTES + " bytes, got " + bytes.length);
      return isLE2 ? bytesToNumberLE(bytes) : bytesToNumberBE(bytes);
    }
  });
  return Object.freeze(f);
}
function getFieldBytesLength(fieldOrder) {
  if (typeof fieldOrder !== "bigint")
    throw new Error("field order must be bigint");
  const bitLength = fieldOrder.toString(2).length;
  return Math.ceil(bitLength / 8);
}
function getMinHashLength(fieldOrder) {
  const length = getFieldBytesLength(fieldOrder);
  return length + Math.ceil(length / 2);
}
function mapHashToField(key2, fieldOrder, isLE2 = false) {
  const len = key2.length;
  const fieldLen = getFieldBytesLength(fieldOrder);
  const minLen = getMinHashLength(fieldOrder);
  if (len < 16 || len < minLen || len > 1024)
    throw new Error("expected " + minLen + "-1024 bytes of input, got " + len);
  const num3 = isLE2 ? bytesToNumberLE(key2) : bytesToNumberBE(key2);
  const reduced = mod(num3, fieldOrder - _1n3) + _1n3;
  return isLE2 ? numberToBytesLE(reduced, fieldLen) : numberToBytesBE(reduced, fieldLen);
}

// node_modules/@noble/curves/esm/abstract/curve.js
var _0n4 = BigInt(0);
var _1n4 = BigInt(1);
function constTimeNegate(condition2, item) {
  const neg = item.negate();
  return condition2 ? neg : item;
}
function validateW(W, bits) {
  if (!Number.isSafeInteger(W) || W <= 0 || W > bits)
    throw new Error("invalid window size, expected [1.." + bits + "], got W=" + W);
}
function calcWOpts(W, bits) {
  validateW(W, bits);
  const windows = Math.ceil(bits / W) + 1;
  const windowSize = 2 ** (W - 1);
  return { windows, windowSize };
}
function validateMSMPoints(points, c) {
  if (!Array.isArray(points))
    throw new Error("array expected");
  points.forEach((p, i) => {
    if (!(p instanceof c))
      throw new Error("invalid point at index " + i);
  });
}
function validateMSMScalars(scalars, field) {
  if (!Array.isArray(scalars))
    throw new Error("array of scalars expected");
  scalars.forEach((s, i) => {
    if (!field.isValid(s))
      throw new Error("invalid scalar at index " + i);
  });
}
var pointPrecomputes = /* @__PURE__ */ new WeakMap();
var pointWindowSizes = /* @__PURE__ */ new WeakMap();
function getW(P) {
  return pointWindowSizes.get(P) || 1;
}
function wNAF(c, bits) {
  return {
    constTimeNegate,
    hasPrecomputes(elm) {
      return getW(elm) !== 1;
    },
    // non-const time multiplication ladder
    unsafeLadder(elm, n, p = c.ZERO) {
      let d = elm;
      while (n > _0n4) {
        if (n & _1n4)
          p = p.add(d);
        d = d.double();
        n >>= _1n4;
      }
      return p;
    },
    /**
     * Creates a wNAF precomputation window. Used for caching.
     * Default window size is set by `utils.precompute()` and is equal to 8.
     * Number of precomputed points depends on the curve size:
     * 2^(𝑊−1) * (Math.ceil(𝑛 / 𝑊) + 1), where:
     * - 𝑊 is the window size
     * - 𝑛 is the bitlength of the curve order.
     * For a 256-bit curve and window size 8, the number of precomputed points is 128 * 33 = 4224.
     * @param elm Point instance
     * @param W window size
     * @returns precomputed point tables flattened to a single array
     */
    precomputeWindow(elm, W) {
      const { windows, windowSize } = calcWOpts(W, bits);
      const points = [];
      let p = elm;
      let base2 = p;
      for (let window2 = 0; window2 < windows; window2++) {
        base2 = p;
        points.push(base2);
        for (let i = 1; i < windowSize; i++) {
          base2 = base2.add(p);
          points.push(base2);
        }
        p = base2.double();
      }
      return points;
    },
    /**
     * Implements ec multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @returns real and fake (for const-time) points
     */
    wNAF(W, precomputes, n) {
      const { windows, windowSize } = calcWOpts(W, bits);
      let p = c.ZERO;
      let f = c.BASE;
      const mask = BigInt(2 ** W - 1);
      const maxNumber = 2 ** W;
      const shiftBy = BigInt(W);
      for (let window2 = 0; window2 < windows; window2++) {
        const offset = window2 * windowSize;
        let wbits = Number(n & mask);
        n >>= shiftBy;
        if (wbits > windowSize) {
          wbits -= maxNumber;
          n += _1n4;
        }
        const offset1 = offset;
        const offset2 = offset + Math.abs(wbits) - 1;
        const cond1 = window2 % 2 !== 0;
        const cond2 = wbits < 0;
        if (wbits === 0) {
          f = f.add(constTimeNegate(cond1, precomputes[offset1]));
        } else {
          p = p.add(constTimeNegate(cond2, precomputes[offset2]));
        }
      }
      return { p, f };
    },
    /**
     * Implements ec unsafe (non const-time) multiplication using precomputed tables and w-ary non-adjacent form.
     * @param W window size
     * @param precomputes precomputed tables
     * @param n scalar (we don't check here, but should be less than curve order)
     * @param acc accumulator point to add result of multiplication
     * @returns point
     */
    wNAFUnsafe(W, precomputes, n, acc = c.ZERO) {
      const { windows, windowSize } = calcWOpts(W, bits);
      const mask = BigInt(2 ** W - 1);
      const maxNumber = 2 ** W;
      const shiftBy = BigInt(W);
      for (let window2 = 0; window2 < windows; window2++) {
        const offset = window2 * windowSize;
        if (n === _0n4)
          break;
        let wbits = Number(n & mask);
        n >>= shiftBy;
        if (wbits > windowSize) {
          wbits -= maxNumber;
          n += _1n4;
        }
        if (wbits === 0)
          continue;
        let curr = precomputes[offset + Math.abs(wbits) - 1];
        if (wbits < 0)
          curr = curr.negate();
        acc = acc.add(curr);
      }
      return acc;
    },
    getPrecomputes(W, P, transform) {
      let comp = pointPrecomputes.get(P);
      if (!comp) {
        comp = this.precomputeWindow(P, W);
        if (W !== 1)
          pointPrecomputes.set(P, transform(comp));
      }
      return comp;
    },
    wNAFCached(P, n, transform) {
      const W = getW(P);
      return this.wNAF(W, this.getPrecomputes(W, P, transform), n);
    },
    wNAFCachedUnsafe(P, n, transform, prev) {
      const W = getW(P);
      if (W === 1)
        return this.unsafeLadder(P, n, prev);
      return this.wNAFUnsafe(W, this.getPrecomputes(W, P, transform), n, prev);
    },
    // We calculate precomputes for elliptic curve point multiplication
    // using windowed method. This specifies window size and
    // stores precomputed values. Usually only base point would be precomputed.
    setWindowSize(P, W) {
      validateW(W, bits);
      pointWindowSizes.set(P, W);
      pointPrecomputes.delete(P);
    }
  };
}
function pippenger(c, fieldN, points, scalars) {
  validateMSMPoints(points, c);
  validateMSMScalars(scalars, fieldN);
  if (points.length !== scalars.length)
    throw new Error("arrays of points and scalars must have equal length");
  const zero = c.ZERO;
  const wbits = bitLen(BigInt(points.length));
  const windowSize = wbits > 12 ? wbits - 3 : wbits > 4 ? wbits - 2 : wbits ? 2 : 1;
  const MASK = (1 << windowSize) - 1;
  const buckets = new Array(MASK + 1).fill(zero);
  const lastBits = Math.floor((fieldN.BITS - 1) / windowSize) * windowSize;
  let sum = zero;
  for (let i = lastBits; i >= 0; i -= windowSize) {
    buckets.fill(zero);
    for (let j = 0; j < scalars.length; j++) {
      const scalar = scalars[j];
      const wbits2 = Number(scalar >> BigInt(i) & BigInt(MASK));
      buckets[wbits2] = buckets[wbits2].add(points[j]);
    }
    let resI = zero;
    for (let j = buckets.length - 1, sumI = zero; j > 0; j--) {
      sumI = sumI.add(buckets[j]);
      resI = resI.add(sumI);
    }
    sum = sum.add(resI);
    if (i !== 0)
      for (let j = 0; j < windowSize; j++)
        sum = sum.double();
  }
  return sum;
}
function validateBasic(curve) {
  validateField(curve.Fp);
  validateObject(curve, {
    n: "bigint",
    h: "bigint",
    Gx: "field",
    Gy: "field"
  }, {
    nBitLength: "isSafeInteger",
    nByteLength: "isSafeInteger"
  });
  return Object.freeze({
    ...nLength(curve.n, curve.nBitLength),
    ...curve,
    ...{ p: curve.Fp.ORDER }
  });
}

// node_modules/@noble/curves/esm/abstract/weierstrass.js
function validateSigVerOpts(opts) {
  if (opts.lowS !== void 0)
    abool("lowS", opts.lowS);
  if (opts.prehash !== void 0)
    abool("prehash", opts.prehash);
}
function validatePointOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    a: "field",
    b: "field"
  }, {
    allowedPrivateKeyLengths: "array",
    wrapPrivateKey: "boolean",
    isTorsionFree: "function",
    clearCofactor: "function",
    allowInfinityPoint: "boolean",
    fromBytes: "function",
    toBytes: "function"
  });
  const { endo, Fp, a } = opts;
  if (endo) {
    if (!Fp.eql(a, Fp.ZERO)) {
      throw new Error("invalid endomorphism, can only be defined for Koblitz curves that have a=0");
    }
    if (typeof endo !== "object" || typeof endo.beta !== "bigint" || typeof endo.splitScalar !== "function") {
      throw new Error("invalid endomorphism, expected beta: bigint and splitScalar: function");
    }
  }
  return Object.freeze({ ...opts });
}
var { bytesToNumberBE: b2n, hexToBytes: h2b } = utils_exports;
var DERErr = class extends Error {
  constructor(m = "") {
    super(m);
  }
};
var DER = {
  // asn.1 DER encoding utils
  Err: DERErr,
  // Basic building block is TLV (Tag-Length-Value)
  _tlv: {
    encode: (tag, data) => {
      const { Err: E } = DER;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length & 1)
        throw new E("tlv.encode: unpadded data");
      const dataLen = data.length / 2;
      const len = numberToHexUnpadded(dataLen);
      if (len.length / 2 & 128)
        throw new E("tlv.encode: long form length too big");
      const lenLen = dataLen > 127 ? numberToHexUnpadded(len.length / 2 | 128) : "";
      const t = numberToHexUnpadded(tag);
      return t + lenLen + len + data;
    },
    // v - value, l - left bytes (unparsed)
    decode(tag, data) {
      const { Err: E } = DER;
      let pos = 0;
      if (tag < 0 || tag > 256)
        throw new E("tlv.encode: wrong tag");
      if (data.length < 2 || data[pos++] !== tag)
        throw new E("tlv.decode: wrong tlv");
      const first = data[pos++];
      const isLong = !!(first & 128);
      let length = 0;
      if (!isLong)
        length = first;
      else {
        const lenLen = first & 127;
        if (!lenLen)
          throw new E("tlv.decode(long): indefinite length not supported");
        if (lenLen > 4)
          throw new E("tlv.decode(long): byte length is too big");
        const lengthBytes = data.subarray(pos, pos + lenLen);
        if (lengthBytes.length !== lenLen)
          throw new E("tlv.decode: length bytes not complete");
        if (lengthBytes[0] === 0)
          throw new E("tlv.decode(long): zero leftmost byte");
        for (const b of lengthBytes)
          length = length << 8 | b;
        pos += lenLen;
        if (length < 128)
          throw new E("tlv.decode(long): not minimal encoding");
      }
      const v = data.subarray(pos, pos + length);
      if (v.length !== length)
        throw new E("tlv.decode: wrong value length");
      return { v, l: data.subarray(pos + length) };
    }
  },
  // https://crypto.stackexchange.com/a/57734 Leftmost bit of first byte is 'negative' flag,
  // since we always use positive integers here. It must always be empty:
  // - add zero byte if exists
  // - if next byte doesn't have a flag, leading zero is not allowed (minimal encoding)
  _int: {
    encode(num3) {
      const { Err: E } = DER;
      if (num3 < _0n5)
        throw new E("integer: negative integers are not allowed");
      let hex = numberToHexUnpadded(num3);
      if (Number.parseInt(hex[0], 16) & 8)
        hex = "00" + hex;
      if (hex.length & 1)
        throw new E("unexpected DER parsing assertion: unpadded hex");
      return hex;
    },
    decode(data) {
      const { Err: E } = DER;
      if (data[0] & 128)
        throw new E("invalid signature integer: negative");
      if (data[0] === 0 && !(data[1] & 128))
        throw new E("invalid signature integer: unnecessary leading zero");
      return b2n(data);
    }
  },
  toSig(hex) {
    const { Err: E, _int: int2, _tlv: tlv } = DER;
    const data = typeof hex === "string" ? h2b(hex) : hex;
    abytes3(data);
    const { v: seqBytes, l: seqLeftBytes } = tlv.decode(48, data);
    if (seqLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    const { v: rBytes, l: rLeftBytes } = tlv.decode(2, seqBytes);
    const { v: sBytes, l: sLeftBytes } = tlv.decode(2, rLeftBytes);
    if (sLeftBytes.length)
      throw new E("invalid signature: left bytes after parsing");
    return { r: int2.decode(rBytes), s: int2.decode(sBytes) };
  },
  hexFromSig(sig) {
    const { _tlv: tlv, _int: int2 } = DER;
    const rs = tlv.encode(2, int2.encode(sig.r));
    const ss = tlv.encode(2, int2.encode(sig.s));
    const seq = rs + ss;
    return tlv.encode(48, seq);
  }
};
var _0n5 = BigInt(0);
var _1n5 = BigInt(1);
var _2n4 = BigInt(2);
var _3n2 = BigInt(3);
var _4n2 = BigInt(4);
function weierstrassPoints(opts) {
  const CURVE = validatePointOpts(opts);
  const { Fp } = CURVE;
  const Fn = Field(CURVE.n, CURVE.nBitLength);
  const toBytes3 = CURVE.toBytes || ((_c, point, _isCompressed) => {
    const a = point.toAffine();
    return concatBytes2(Uint8Array.from([4]), Fp.toBytes(a.x), Fp.toBytes(a.y));
  });
  const fromBytes = CURVE.fromBytes || ((bytes) => {
    const tail = bytes.subarray(1);
    const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
    const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
    return { x, y };
  });
  function weierstrassEquation(x) {
    const { a, b } = CURVE;
    const x2 = Fp.sqr(x);
    const x3 = Fp.mul(x2, x);
    return Fp.add(Fp.add(x3, Fp.mul(x, a)), b);
  }
  if (!Fp.eql(Fp.sqr(CURVE.Gy), weierstrassEquation(CURVE.Gx)))
    throw new Error("bad generator point: equation left != right");
  function isWithinCurveOrder(num3) {
    return inRange(num3, _1n5, CURVE.n);
  }
  function normPrivateKeyToScalar(key2) {
    const { allowedPrivateKeyLengths: lengths, nByteLength, wrapPrivateKey, n: N } = CURVE;
    if (lengths && typeof key2 !== "bigint") {
      if (isBytes3(key2))
        key2 = bytesToHex(key2);
      if (typeof key2 !== "string" || !lengths.includes(key2.length))
        throw new Error("invalid private key");
      key2 = key2.padStart(nByteLength * 2, "0");
    }
    let num3;
    try {
      num3 = typeof key2 === "bigint" ? key2 : bytesToNumberBE(ensureBytes("private key", key2, nByteLength));
    } catch (error) {
      throw new Error("invalid private key, expected hex or " + nByteLength + " bytes, got " + typeof key2);
    }
    if (wrapPrivateKey)
      num3 = mod(num3, N);
    aInRange("private key", num3, _1n5, N);
    return num3;
  }
  function assertPrjPoint(other) {
    if (!(other instanceof Point2))
      throw new Error("ProjectivePoint expected");
  }
  const toAffineMemo = memoized((p, iz) => {
    const { px: x, py: y, pz: z } = p;
    if (Fp.eql(z, Fp.ONE))
      return { x, y };
    const is0 = p.is0();
    if (iz == null)
      iz = is0 ? Fp.ONE : Fp.inv(z);
    const ax = Fp.mul(x, iz);
    const ay = Fp.mul(y, iz);
    const zz = Fp.mul(z, iz);
    if (is0)
      return { x: Fp.ZERO, y: Fp.ZERO };
    if (!Fp.eql(zz, Fp.ONE))
      throw new Error("invZ was invalid");
    return { x: ax, y: ay };
  });
  const assertValidMemo = memoized((p) => {
    if (p.is0()) {
      if (CURVE.allowInfinityPoint && !Fp.is0(p.py))
        return;
      throw new Error("bad point: ZERO");
    }
    const { x, y } = p.toAffine();
    if (!Fp.isValid(x) || !Fp.isValid(y))
      throw new Error("bad point: x or y not FE");
    const left = Fp.sqr(y);
    const right = weierstrassEquation(x);
    if (!Fp.eql(left, right))
      throw new Error("bad point: equation left != right");
    if (!p.isTorsionFree())
      throw new Error("bad point: not in prime-order subgroup");
    return true;
  });
  class Point2 {
    constructor(px, py, pz) {
      this.px = px;
      this.py = py;
      this.pz = pz;
      if (px == null || !Fp.isValid(px))
        throw new Error("x required");
      if (py == null || !Fp.isValid(py))
        throw new Error("y required");
      if (pz == null || !Fp.isValid(pz))
        throw new Error("z required");
      Object.freeze(this);
    }
    // Does not validate if the point is on-curve.
    // Use fromHex instead, or call assertValidity() later.
    static fromAffine(p) {
      const { x, y } = p || {};
      if (!p || !Fp.isValid(x) || !Fp.isValid(y))
        throw new Error("invalid affine point");
      if (p instanceof Point2)
        throw new Error("projective point not allowed");
      const is0 = (i) => Fp.eql(i, Fp.ZERO);
      if (is0(x) && is0(y))
        return Point2.ZERO;
      return new Point2(x, y, Fp.ONE);
    }
    get x() {
      return this.toAffine().x;
    }
    get y() {
      return this.toAffine().y;
    }
    /**
     * Takes a bunch of Projective Points but executes only one
     * inversion on all of them. Inversion is very slow operation,
     * so this improves performance massively.
     * Optimization: converts a list of projective points to a list of identical points with Z=1.
     */
    static normalizeZ(points) {
      const toInv = Fp.invertBatch(points.map((p) => p.pz));
      return points.map((p, i) => p.toAffine(toInv[i])).map(Point2.fromAffine);
    }
    /**
     * Converts hash string or Uint8Array to Point.
     * @param hex short/long ECDSA hex
     */
    static fromHex(hex) {
      const P = Point2.fromAffine(fromBytes(ensureBytes("pointHex", hex)));
      P.assertValidity();
      return P;
    }
    // Multiplies generator point by privateKey.
    static fromPrivateKey(privateKey) {
      return Point2.BASE.multiply(normPrivateKeyToScalar(privateKey));
    }
    // Multiscalar Multiplication
    static msm(points, scalars) {
      return pippenger(Point2, Fn, points, scalars);
    }
    // "Private method", don't use it directly
    _setWindowSize(windowSize) {
      wnaf.setWindowSize(this, windowSize);
    }
    // A point on curve is valid if it conforms to equation.
    assertValidity() {
      assertValidMemo(this);
    }
    hasEvenY() {
      const { y } = this.toAffine();
      if (Fp.isOdd)
        return !Fp.isOdd(y);
      throw new Error("Field doesn't support isOdd");
    }
    /**
     * Compare one point to another.
     */
    equals(other) {
      assertPrjPoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      const U1 = Fp.eql(Fp.mul(X1, Z2), Fp.mul(X2, Z1));
      const U2 = Fp.eql(Fp.mul(Y1, Z2), Fp.mul(Y2, Z1));
      return U1 && U2;
    }
    /**
     * Flips point to one corresponding to (x, -y) in Affine coordinates.
     */
    negate() {
      return new Point2(this.px, Fp.neg(this.py), this.pz);
    }
    // Renes-Costello-Batina exception-free doubling formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 3
    // Cost: 8M + 3S + 3*a + 2*b3 + 15add.
    double() {
      const { a, b } = CURVE;
      const b3 = Fp.mul(b, _3n2);
      const { px: X1, py: Y1, pz: Z1 } = this;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      let t0 = Fp.mul(X1, X1);
      let t1 = Fp.mul(Y1, Y1);
      let t2 = Fp.mul(Z1, Z1);
      let t3 = Fp.mul(X1, Y1);
      t3 = Fp.add(t3, t3);
      Z3 = Fp.mul(X1, Z1);
      Z3 = Fp.add(Z3, Z3);
      X3 = Fp.mul(a, Z3);
      Y3 = Fp.mul(b3, t2);
      Y3 = Fp.add(X3, Y3);
      X3 = Fp.sub(t1, Y3);
      Y3 = Fp.add(t1, Y3);
      Y3 = Fp.mul(X3, Y3);
      X3 = Fp.mul(t3, X3);
      Z3 = Fp.mul(b3, Z3);
      t2 = Fp.mul(a, t2);
      t3 = Fp.sub(t0, t2);
      t3 = Fp.mul(a, t3);
      t3 = Fp.add(t3, Z3);
      Z3 = Fp.add(t0, t0);
      t0 = Fp.add(Z3, t0);
      t0 = Fp.add(t0, t2);
      t0 = Fp.mul(t0, t3);
      Y3 = Fp.add(Y3, t0);
      t2 = Fp.mul(Y1, Z1);
      t2 = Fp.add(t2, t2);
      t0 = Fp.mul(t2, t3);
      X3 = Fp.sub(X3, t0);
      Z3 = Fp.mul(t2, t1);
      Z3 = Fp.add(Z3, Z3);
      Z3 = Fp.add(Z3, Z3);
      return new Point2(X3, Y3, Z3);
    }
    // Renes-Costello-Batina exception-free addition formula.
    // There is 30% faster Jacobian formula, but it is not complete.
    // https://eprint.iacr.org/2015/1060, algorithm 1
    // Cost: 12M + 0S + 3*a + 3*b3 + 23add.
    add(other) {
      assertPrjPoint(other);
      const { px: X1, py: Y1, pz: Z1 } = this;
      const { px: X2, py: Y2, pz: Z2 } = other;
      let X3 = Fp.ZERO, Y3 = Fp.ZERO, Z3 = Fp.ZERO;
      const a = CURVE.a;
      const b3 = Fp.mul(CURVE.b, _3n2);
      let t0 = Fp.mul(X1, X2);
      let t1 = Fp.mul(Y1, Y2);
      let t2 = Fp.mul(Z1, Z2);
      let t3 = Fp.add(X1, Y1);
      let t4 = Fp.add(X2, Y2);
      t3 = Fp.mul(t3, t4);
      t4 = Fp.add(t0, t1);
      t3 = Fp.sub(t3, t4);
      t4 = Fp.add(X1, Z1);
      let t5 = Fp.add(X2, Z2);
      t4 = Fp.mul(t4, t5);
      t5 = Fp.add(t0, t2);
      t4 = Fp.sub(t4, t5);
      t5 = Fp.add(Y1, Z1);
      X3 = Fp.add(Y2, Z2);
      t5 = Fp.mul(t5, X3);
      X3 = Fp.add(t1, t2);
      t5 = Fp.sub(t5, X3);
      Z3 = Fp.mul(a, t4);
      X3 = Fp.mul(b3, t2);
      Z3 = Fp.add(X3, Z3);
      X3 = Fp.sub(t1, Z3);
      Z3 = Fp.add(t1, Z3);
      Y3 = Fp.mul(X3, Z3);
      t1 = Fp.add(t0, t0);
      t1 = Fp.add(t1, t0);
      t2 = Fp.mul(a, t2);
      t4 = Fp.mul(b3, t4);
      t1 = Fp.add(t1, t2);
      t2 = Fp.sub(t0, t2);
      t2 = Fp.mul(a, t2);
      t4 = Fp.add(t4, t2);
      t0 = Fp.mul(t1, t4);
      Y3 = Fp.add(Y3, t0);
      t0 = Fp.mul(t5, t4);
      X3 = Fp.mul(t3, X3);
      X3 = Fp.sub(X3, t0);
      t0 = Fp.mul(t3, t1);
      Z3 = Fp.mul(t5, Z3);
      Z3 = Fp.add(Z3, t0);
      return new Point2(X3, Y3, Z3);
    }
    subtract(other) {
      return this.add(other.negate());
    }
    is0() {
      return this.equals(Point2.ZERO);
    }
    wNAF(n) {
      return wnaf.wNAFCached(this, n, Point2.normalizeZ);
    }
    /**
     * Non-constant-time multiplication. Uses double-and-add algorithm.
     * It's faster, but should only be used when you don't care about
     * an exposed private key e.g. sig verification, which works over *public* keys.
     */
    multiplyUnsafe(sc) {
      const { endo, n: N } = CURVE;
      aInRange("scalar", sc, _0n5, N);
      const I = Point2.ZERO;
      if (sc === _0n5)
        return I;
      if (this.is0() || sc === _1n5)
        return this;
      if (!endo || wnaf.hasPrecomputes(this))
        return wnaf.wNAFCachedUnsafe(this, sc, Point2.normalizeZ);
      let { k1neg, k1, k2neg, k2 } = endo.splitScalar(sc);
      let k1p = I;
      let k2p = I;
      let d = this;
      while (k1 > _0n5 || k2 > _0n5) {
        if (k1 & _1n5)
          k1p = k1p.add(d);
        if (k2 & _1n5)
          k2p = k2p.add(d);
        d = d.double();
        k1 >>= _1n5;
        k2 >>= _1n5;
      }
      if (k1neg)
        k1p = k1p.negate();
      if (k2neg)
        k2p = k2p.negate();
      k2p = new Point2(Fp.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
      return k1p.add(k2p);
    }
    /**
     * Constant time multiplication.
     * Uses wNAF method. Windowed method may be 10% faster,
     * but takes 2x longer to generate and consumes 2x memory.
     * Uses precomputes when available.
     * Uses endomorphism for Koblitz curves.
     * @param scalar by which the point would be multiplied
     * @returns New point
     */
    multiply(scalar) {
      const { endo, n: N } = CURVE;
      aInRange("scalar", scalar, _1n5, N);
      let point, fake;
      if (endo) {
        const { k1neg, k1, k2neg, k2 } = endo.splitScalar(scalar);
        let { p: k1p, f: f1p } = this.wNAF(k1);
        let { p: k2p, f: f2p } = this.wNAF(k2);
        k1p = wnaf.constTimeNegate(k1neg, k1p);
        k2p = wnaf.constTimeNegate(k2neg, k2p);
        k2p = new Point2(Fp.mul(k2p.px, endo.beta), k2p.py, k2p.pz);
        point = k1p.add(k2p);
        fake = f1p.add(f2p);
      } else {
        const { p, f } = this.wNAF(scalar);
        point = p;
        fake = f;
      }
      return Point2.normalizeZ([point, fake])[0];
    }
    /**
     * Efficiently calculate `aP + bQ`. Unsafe, can expose private key, if used incorrectly.
     * Not using Strauss-Shamir trick: precomputation tables are faster.
     * The trick could be useful if both P and Q are not G (not in our case).
     * @returns non-zero affine point
     */
    multiplyAndAddUnsafe(Q, a, b) {
      const G = Point2.BASE;
      const mul = (P, a2) => a2 === _0n5 || a2 === _1n5 || !P.equals(G) ? P.multiplyUnsafe(a2) : P.multiply(a2);
      const sum = mul(this, a).add(mul(Q, b));
      return sum.is0() ? void 0 : sum;
    }
    // Converts Projective point to affine (x, y) coordinates.
    // Can accept precomputed Z^-1 - for example, from invertBatch.
    // (x, y, z) ∋ (x=x/z, y=y/z)
    toAffine(iz) {
      return toAffineMemo(this, iz);
    }
    isTorsionFree() {
      const { h: cofactor, isTorsionFree } = CURVE;
      if (cofactor === _1n5)
        return true;
      if (isTorsionFree)
        return isTorsionFree(Point2, this);
      throw new Error("isTorsionFree() has not been declared for the elliptic curve");
    }
    clearCofactor() {
      const { h: cofactor, clearCofactor } = CURVE;
      if (cofactor === _1n5)
        return this;
      if (clearCofactor)
        return clearCofactor(Point2, this);
      return this.multiplyUnsafe(CURVE.h);
    }
    toRawBytes(isCompressed = true) {
      abool("isCompressed", isCompressed);
      this.assertValidity();
      return toBytes3(Point2, this, isCompressed);
    }
    toHex(isCompressed = true) {
      abool("isCompressed", isCompressed);
      return bytesToHex(this.toRawBytes(isCompressed));
    }
  }
  Point2.BASE = new Point2(CURVE.Gx, CURVE.Gy, Fp.ONE);
  Point2.ZERO = new Point2(Fp.ZERO, Fp.ONE, Fp.ZERO);
  const _bits = CURVE.nBitLength;
  const wnaf = wNAF(Point2, CURVE.endo ? Math.ceil(_bits / 2) : _bits);
  return {
    CURVE,
    ProjectivePoint: Point2,
    normPrivateKeyToScalar,
    weierstrassEquation,
    isWithinCurveOrder
  };
}
function validateOpts(curve) {
  const opts = validateBasic(curve);
  validateObject(opts, {
    hash: "hash",
    hmac: "function",
    randomBytes: "function"
  }, {
    bits2int: "function",
    bits2int_modN: "function",
    lowS: "boolean"
  });
  return Object.freeze({ lowS: true, ...opts });
}
function weierstrass(curveDef) {
  const CURVE = validateOpts(curveDef);
  const { Fp, n: CURVE_ORDER } = CURVE;
  const compressedLen = Fp.BYTES + 1;
  const uncompressedLen = 2 * Fp.BYTES + 1;
  function modN(a) {
    return mod(a, CURVE_ORDER);
  }
  function invN(a) {
    return invert(a, CURVE_ORDER);
  }
  const { ProjectivePoint: Point2, normPrivateKeyToScalar, weierstrassEquation, isWithinCurveOrder } = weierstrassPoints({
    ...CURVE,
    toBytes(_c, point, isCompressed) {
      const a = point.toAffine();
      const x = Fp.toBytes(a.x);
      const cat = concatBytes2;
      abool("isCompressed", isCompressed);
      if (isCompressed) {
        return cat(Uint8Array.from([point.hasEvenY() ? 2 : 3]), x);
      } else {
        return cat(Uint8Array.from([4]), x, Fp.toBytes(a.y));
      }
    },
    fromBytes(bytes) {
      const len = bytes.length;
      const head = bytes[0];
      const tail = bytes.subarray(1);
      if (len === compressedLen && (head === 2 || head === 3)) {
        const x = bytesToNumberBE(tail);
        if (!inRange(x, _1n5, Fp.ORDER))
          throw new Error("Point is not on curve");
        const y2 = weierstrassEquation(x);
        let y;
        try {
          y = Fp.sqrt(y2);
        } catch (sqrtError) {
          const suffix = sqrtError instanceof Error ? ": " + sqrtError.message : "";
          throw new Error("Point is not on curve" + suffix);
        }
        const isYOdd = (y & _1n5) === _1n5;
        const isHeadOdd = (head & 1) === 1;
        if (isHeadOdd !== isYOdd)
          y = Fp.neg(y);
        return { x, y };
      } else if (len === uncompressedLen && head === 4) {
        const x = Fp.fromBytes(tail.subarray(0, Fp.BYTES));
        const y = Fp.fromBytes(tail.subarray(Fp.BYTES, 2 * Fp.BYTES));
        return { x, y };
      } else {
        const cl = compressedLen;
        const ul = uncompressedLen;
        throw new Error("invalid Point, expected length of " + cl + ", or uncompressed " + ul + ", got " + len);
      }
    }
  });
  const numToNByteStr = (num3) => bytesToHex(numberToBytesBE(num3, CURVE.nByteLength));
  function isBiggerThanHalfOrder(number) {
    const HALF = CURVE_ORDER >> _1n5;
    return number > HALF;
  }
  function normalizeS(s) {
    return isBiggerThanHalfOrder(s) ? modN(-s) : s;
  }
  const slcNum = (b, from, to) => bytesToNumberBE(b.slice(from, to));
  class Signature {
    constructor(r, s, recovery) {
      this.r = r;
      this.s = s;
      this.recovery = recovery;
      this.assertValidity();
    }
    // pair (bytes of r, bytes of s)
    static fromCompact(hex) {
      const l = CURVE.nByteLength;
      hex = ensureBytes("compactSignature", hex, l * 2);
      return new Signature(slcNum(hex, 0, l), slcNum(hex, l, 2 * l));
    }
    // DER encoded ECDSA signature
    // https://bitcoin.stackexchange.com/questions/57644/what-are-the-parts-of-a-bitcoin-transaction-input-script
    static fromDER(hex) {
      const { r, s } = DER.toSig(ensureBytes("DER", hex));
      return new Signature(r, s);
    }
    assertValidity() {
      aInRange("r", this.r, _1n5, CURVE_ORDER);
      aInRange("s", this.s, _1n5, CURVE_ORDER);
    }
    addRecoveryBit(recovery) {
      return new Signature(this.r, this.s, recovery);
    }
    recoverPublicKey(msgHash) {
      const { r, s, recovery: rec } = this;
      const h = bits2int_modN(ensureBytes("msgHash", msgHash));
      if (rec == null || ![0, 1, 2, 3].includes(rec))
        throw new Error("recovery id invalid");
      const radj = rec === 2 || rec === 3 ? r + CURVE.n : r;
      if (radj >= Fp.ORDER)
        throw new Error("recovery id 2 or 3 invalid");
      const prefix = (rec & 1) === 0 ? "02" : "03";
      const R = Point2.fromHex(prefix + numToNByteStr(radj));
      const ir = invN(radj);
      const u1 = modN(-h * ir);
      const u2 = modN(s * ir);
      const Q = Point2.BASE.multiplyAndAddUnsafe(R, u1, u2);
      if (!Q)
        throw new Error("point at infinify");
      Q.assertValidity();
      return Q;
    }
    // Signatures should be low-s, to prevent malleability.
    hasHighS() {
      return isBiggerThanHalfOrder(this.s);
    }
    normalizeS() {
      return this.hasHighS() ? new Signature(this.r, modN(-this.s), this.recovery) : this;
    }
    // DER-encoded
    toDERRawBytes() {
      return hexToBytes(this.toDERHex());
    }
    toDERHex() {
      return DER.hexFromSig({ r: this.r, s: this.s });
    }
    // padded bytes of r, then padded bytes of s
    toCompactRawBytes() {
      return hexToBytes(this.toCompactHex());
    }
    toCompactHex() {
      return numToNByteStr(this.r) + numToNByteStr(this.s);
    }
  }
  const utils = {
    isValidPrivateKey(privateKey) {
      try {
        normPrivateKeyToScalar(privateKey);
        return true;
      } catch (error) {
        return false;
      }
    },
    normPrivateKeyToScalar,
    /**
     * Produces cryptographically secure private key from random of size
     * (groupLen + ceil(groupLen / 2)) with modulo bias being negligible.
     */
    randomPrivateKey: () => {
      const length = getMinHashLength(CURVE.n);
      return mapHashToField(CURVE.randomBytes(length), CURVE.n);
    },
    /**
     * Creates precompute table for an arbitrary EC point. Makes point "cached".
     * Allows to massively speed-up `point.multiply(scalar)`.
     * @returns cached point
     * @example
     * const fast = utils.precompute(8, ProjectivePoint.fromHex(someonesPubKey));
     * fast.multiply(privKey); // much faster ECDH now
     */
    precompute(windowSize = 8, point = Point2.BASE) {
      point._setWindowSize(windowSize);
      point.multiply(BigInt(3));
      return point;
    }
  };
  function getPublicKey(privateKey, isCompressed = true) {
    return Point2.fromPrivateKey(privateKey).toRawBytes(isCompressed);
  }
  function isProbPub(item) {
    const arr = isBytes3(item);
    const str2 = typeof item === "string";
    const len = (arr || str2) && item.length;
    if (arr)
      return len === compressedLen || len === uncompressedLen;
    if (str2)
      return len === 2 * compressedLen || len === 2 * uncompressedLen;
    if (item instanceof Point2)
      return true;
    return false;
  }
  function getSharedSecret(privateA, publicB, isCompressed = true) {
    if (isProbPub(privateA))
      throw new Error("first arg must be private key");
    if (!isProbPub(publicB))
      throw new Error("second arg must be public key");
    const b = Point2.fromHex(publicB);
    return b.multiply(normPrivateKeyToScalar(privateA)).toRawBytes(isCompressed);
  }
  const bits2int = CURVE.bits2int || function(bytes) {
    if (bytes.length > 8192)
      throw new Error("input is too large");
    const num3 = bytesToNumberBE(bytes);
    const delta = bytes.length * 8 - CURVE.nBitLength;
    return delta > 0 ? num3 >> BigInt(delta) : num3;
  };
  const bits2int_modN = CURVE.bits2int_modN || function(bytes) {
    return modN(bits2int(bytes));
  };
  const ORDER_MASK = bitMask(CURVE.nBitLength);
  function int2octets(num3) {
    aInRange("num < 2^" + CURVE.nBitLength, num3, _0n5, ORDER_MASK);
    return numberToBytesBE(num3, CURVE.nByteLength);
  }
  function prepSig(msgHash, privateKey, opts = defaultSigOpts) {
    if (["recovered", "canonical"].some((k) => k in opts))
      throw new Error("sign() legacy options not supported");
    const { hash, randomBytes: randomBytes4 } = CURVE;
    let { lowS, prehash, extraEntropy: ent } = opts;
    if (lowS == null)
      lowS = true;
    msgHash = ensureBytes("msgHash", msgHash);
    validateSigVerOpts(opts);
    if (prehash)
      msgHash = ensureBytes("prehashed msgHash", hash(msgHash));
    const h1int = bits2int_modN(msgHash);
    const d = normPrivateKeyToScalar(privateKey);
    const seedArgs = [int2octets(d), int2octets(h1int)];
    if (ent != null && ent !== false) {
      const e = ent === true ? randomBytes4(Fp.BYTES) : ent;
      seedArgs.push(ensureBytes("extraEntropy", e));
    }
    const seed = concatBytes2(...seedArgs);
    const m = h1int;
    function k2sig(kBytes) {
      const k = bits2int(kBytes);
      if (!isWithinCurveOrder(k))
        return;
      const ik = invN(k);
      const q = Point2.BASE.multiply(k).toAffine();
      const r = modN(q.x);
      if (r === _0n5)
        return;
      const s = modN(ik * modN(m + r * d));
      if (s === _0n5)
        return;
      let recovery = (q.x === r ? 0 : 2) | Number(q.y & _1n5);
      let normS = s;
      if (lowS && isBiggerThanHalfOrder(s)) {
        normS = normalizeS(s);
        recovery ^= 1;
      }
      return new Signature(r, normS, recovery);
    }
    return { seed, k2sig };
  }
  const defaultSigOpts = { lowS: CURVE.lowS, prehash: false };
  const defaultVerOpts = { lowS: CURVE.lowS, prehash: false };
  function sign2(msgHash, privKey, opts = defaultSigOpts) {
    const { seed, k2sig } = prepSig(msgHash, privKey, opts);
    const C = CURVE;
    const drbg = createHmacDrbg(C.hash.outputLen, C.nByteLength, C.hmac);
    return drbg(seed, k2sig);
  }
  Point2.BASE._setWindowSize(8);
  function verify(signature, msgHash, publicKey, opts = defaultVerOpts) {
    const sg = signature;
    msgHash = ensureBytes("msgHash", msgHash);
    publicKey = ensureBytes("publicKey", publicKey);
    const { lowS, prehash, format } = opts;
    validateSigVerOpts(opts);
    if ("strict" in opts)
      throw new Error("options.strict was renamed to lowS");
    if (format !== void 0 && format !== "compact" && format !== "der")
      throw new Error("format must be compact or der");
    const isHex = typeof sg === "string" || isBytes3(sg);
    const isObj2 = !isHex && !format && typeof sg === "object" && sg !== null && typeof sg.r === "bigint" && typeof sg.s === "bigint";
    if (!isHex && !isObj2)
      throw new Error("invalid signature, expected Uint8Array, hex string or Signature instance");
    let _sig = void 0;
    let P;
    try {
      if (isObj2)
        _sig = new Signature(sg.r, sg.s);
      if (isHex) {
        try {
          if (format !== "compact")
            _sig = Signature.fromDER(sg);
        } catch (derError) {
          if (!(derError instanceof DER.Err))
            throw derError;
        }
        if (!_sig && format !== "der")
          _sig = Signature.fromCompact(sg);
      }
      P = Point2.fromHex(publicKey);
    } catch (error) {
      return false;
    }
    if (!_sig)
      return false;
    if (lowS && _sig.hasHighS())
      return false;
    if (prehash)
      msgHash = CURVE.hash(msgHash);
    const { r, s } = _sig;
    const h = bits2int_modN(msgHash);
    const is = invN(s);
    const u1 = modN(h * is);
    const u2 = modN(r * is);
    const R = Point2.BASE.multiplyAndAddUnsafe(P, u1, u2)?.toAffine();
    if (!R)
      return false;
    const v = modN(R.x);
    return v === r;
  }
  return {
    CURVE,
    getPublicKey,
    getSharedSecret,
    sign: sign2,
    verify,
    ProjectivePoint: Point2,
    Signature,
    utils
  };
}

// node_modules/@noble/curves/esm/_shortw_utils.js
function getHash(hash) {
  return {
    hash,
    hmac: (key2, ...msgs) => hmac(hash, key2, concatBytes(...msgs)),
    randomBytes
  };
}
function createCurve(curveDef, defHash) {
  const create = (hash) => weierstrass({ ...curveDef, ...getHash(hash) });
  return { ...create(defHash), create };
}

// node_modules/@noble/curves/esm/secp256k1.js
var secp256k1P = BigInt("0xfffffffffffffffffffffffffffffffffffffffffffffffffffffffefffffc2f");
var secp256k1N = BigInt("0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141");
var _1n6 = BigInt(1);
var _2n5 = BigInt(2);
var divNearest = (a, b) => (a + b / _2n5) / b;
function sqrtMod(y) {
  const P = secp256k1P;
  const _3n3 = BigInt(3), _6n = BigInt(6), _11n = BigInt(11), _22n = BigInt(22);
  const _23n = BigInt(23), _44n = BigInt(44), _88n = BigInt(88);
  const b2 = y * y * y % P;
  const b3 = b2 * b2 * y % P;
  const b6 = pow2(b3, _3n3, P) * b3 % P;
  const b9 = pow2(b6, _3n3, P) * b3 % P;
  const b11 = pow2(b9, _2n5, P) * b2 % P;
  const b22 = pow2(b11, _11n, P) * b11 % P;
  const b44 = pow2(b22, _22n, P) * b22 % P;
  const b88 = pow2(b44, _44n, P) * b44 % P;
  const b176 = pow2(b88, _88n, P) * b88 % P;
  const b220 = pow2(b176, _44n, P) * b44 % P;
  const b223 = pow2(b220, _3n3, P) * b3 % P;
  const t1 = pow2(b223, _23n, P) * b22 % P;
  const t2 = pow2(t1, _6n, P) * b2 % P;
  const root = pow2(t2, _2n5, P);
  if (!Fpk1.eql(Fpk1.sqr(root), y))
    throw new Error("Cannot find square root");
  return root;
}
var Fpk1 = Field(secp256k1P, void 0, void 0, { sqrt: sqrtMod });
var secp256k1 = createCurve({
  a: BigInt(0),
  // equation params: a, b
  b: BigInt(7),
  Fp: Fpk1,
  // Field's prime: 2n**256n - 2n**32n - 2n**9n - 2n**8n - 2n**7n - 2n**6n - 2n**4n - 1n
  n: secp256k1N,
  // Curve order, total count of valid points in the field
  // Base point (x, y) aka generator point
  Gx: BigInt("55066263022277343669578718895168534326250603453777594175500187360389116729240"),
  Gy: BigInt("32670510020758816978083085130507043184471273380659243275938904335757337482424"),
  h: BigInt(1),
  // Cofactor
  lowS: true,
  // Allow only low-S signatures by default in sign() and verify()
  endo: {
    // Endomorphism, see above
    beta: BigInt("0x7ae96a2b657c07106e64479eac3434e99cf0497512f58995c1396c28719501ee"),
    splitScalar: (k) => {
      const n = secp256k1N;
      const a1 = BigInt("0x3086d221a7d46bcde86c90e49284eb15");
      const b1 = -_1n6 * BigInt("0xe4437ed6010e88286f547fa90abfe4c3");
      const a2 = BigInt("0x114ca50f7a8e2f3f657c1108d9d44cfd8");
      const b2 = a1;
      const POW_2_128 = BigInt("0x100000000000000000000000000000000");
      const c1 = divNearest(b2 * k, n);
      const c2 = divNearest(-b1 * k, n);
      let k1 = mod(k - c1 * a1 - c2 * a2, n);
      let k2 = mod(-c1 * b1 - c2 * b2, n);
      const k1neg = k1 > POW_2_128;
      const k2neg = k2 > POW_2_128;
      if (k1neg)
        k1 = n - k1;
      if (k2neg)
        k2 = n - k2;
      if (k1 > POW_2_128 || k2 > POW_2_128) {
        throw new Error("splitScalar: Endomorphism failed, k=" + k);
      }
      return { k1neg, k1, k2neg, k2 };
    }
  }
}, sha256);
var _0n6 = BigInt(0);
var Point = secp256k1.ProjectivePoint;

// packages/sodex-core/src/eip712.ts
var SignatureType = {
  /** Exchange actions (orders, cancels, transfers, revokeAPIKey) - engine-specific domain. */
  EIP712: 1,
  /** API-key lifecycle and builder approval - the "universal" domain. */
  EIP712Universal: 2
};
var ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
var bytesToHex2 = (b) => "0x" + Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
var HEX_BODY_RE = /^[0-9a-fA-F]*$/;
function hexToBytes2(h) {
  const s = h.startsWith("0x") || h.startsWith("0X") ? h.slice(2) : h;
  if (s.length % 2 !== 0) throw new Error(`odd-length hex: ${h}`);
  if (!HEX_BODY_RE.test(s)) throw new Error("not a hex string");
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
var concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};
var utf8 = (s) => utf8ToBytes(s);
var MAX_UINT256 = (1n << 256n) - 1n;
function word(n) {
  let v = BigInt(n);
  if (v < 0n) throw new Error("negative word");
  if (v > MAX_UINT256) throw new Error("word overflows uint256");
  const out = new Uint8Array(32);
  for (let i = 31; i >= 0 && v > 0n; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}
var addressWord = (addr) => {
  const b = hexToBytes2(addr);
  if (b.length !== 20) throw new Error(`expected a 20-byte address, got ${b.length} bytes`);
  const out = new Uint8Array(32);
  out.set(b, 12);
  return out;
};
var keccak256 = (b) => keccak_256(b);
var DOMAIN_TYPEHASH = keccak_256(
  utf8("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)")
);
var makeDomain = (name, chainId) => ({
  name,
  version: "1",
  chainId,
  verifyingContract: ZERO_ADDRESS
});
var domainSeparator = (d) => keccak_256(
  concat(
    DOMAIN_TYPEHASH,
    keccak_256(utf8(d.name)),
    keccak_256(utf8(d.version)),
    word(d.chainId),
    addressWord(d.verifyingContract)
  )
);
var eip712Digest = (d, structHash) => keccak_256(concat(new Uint8Array([25, 1]), domainSeparator(d), structHash));
var EXCHANGE_ACTION_TYPE = "ExchangeAction(bytes32 payloadHash,uint64 nonce)";
var EXCHANGE_ACTION_TYPEHASH = keccak_256(utf8(EXCHANGE_ACTION_TYPE));
var exchangeActionStructHash = (payloadHash, nonce) => keccak_256(concat(EXCHANGE_ACTION_TYPEHASH, payloadHash, word(nonce)));
var payloadJSONFromBody = (type, bodyJSON) => '{"type":' + goJSONStringify(type) + ',"params":' + bodyJSON + "}";
function goJSONStringify(value) {
  if (value === null || value === void 0) return "null";
  if (typeof value === "string") return goQuote(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("non-finite number in payload");
    if (!Number.isInteger(value)) {
      throw new Error(`non-integer number in payload: ${value} (decimals must be strings)`);
    }
    if (!Number.isSafeInteger(value)) {
      throw new Error(`unsafe integer in payload: ${value} (pass a bigint)`);
    }
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return "[" + value.map(goJSONStringify).join(",") + "]";
  if (typeof value === "object") {
    const parts = [];
    for (const [k, v] of Object.entries(value)) {
      if (v === void 0) continue;
      parts.push(goQuote(k) + ":" + goJSONStringify(v));
    }
    return "{" + parts.join(",") + "}";
  }
  throw new Error(`cannot serialise ${typeof value}`);
}
function goQuote(s) {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0);
    switch (ch) {
      case '"':
        out += '\\"';
        continue;
      case "\\":
        out += "\\\\";
        continue;
      case "\n":
        out += "\\n";
        continue;
      case "\r":
        out += "\\r";
        continue;
      case "	":
        out += "\\t";
        continue;
      case "\b":
        out += "\\b";
        continue;
      case "\f":
        out += "\\f";
        continue;
      // Go's encoding/json escapes these by default to keep JSON safe to embed in HTML.
      case "<":
        out += "\\u003c";
        continue;
      case ">":
        out += "\\u003e";
        continue;
      case "&":
        out += "\\u0026";
        continue;
      // ...and these two always, for JSONP safety.
      case "\u2028":
        out += "\\u2028";
        continue;
      case "\u2029":
        out += "\\u2029";
        continue;
    }
    out += c < 32 ? "\\u" + c.toString(16).padStart(4, "0") : ch;
  }
  return out + '"';
}
var EIP712_DOMAIN_FIELDS = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" }
];
var encodeFlatType = (primaryType, fields) => `${primaryType}(${fields.map((f) => `${f.type} ${f.name}`).join(",")})`;
function encodeField(type, value, where) {
  if (type === "string") {
    if (typeof value !== "string") throw new TypeError(`${where}: expected string`);
    return keccak_256(utf8(value));
  }
  if (type === "bytes") {
    if (typeof value !== "string") throw new TypeError(`${where}: expected hex bytes`);
    return keccak_256(hexToBytes2(value));
  }
  if (type === "bytes32") {
    if (typeof value !== "string") throw new TypeError(`${where}: expected bytes32 hex`);
    const b = hexToBytes2(value);
    if (b.length !== 32) throw new RangeError(`${where}: bytes32 must be 32 bytes`);
    return b;
  }
  if (type === "address") {
    if (typeof value !== "string") throw new TypeError(`${where}: expected address`);
    return addressWord(value);
  }
  if (type === "bool") return word(value ? 1 : 0);
  const m = /^uint(\d+)$/.exec(type);
  if (m) {
    const bits = Number(m[1]);
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
      throw new TypeError(`${where}: expected an unsigned integer`);
    }
    if (typeof value === "string" && !/^\d+$/.test(value)) {
      throw new TypeError(`${where}: expected a decimal integer string`);
    }
    const v = BigInt(value);
    if (v < 0n || v >= 1n << BigInt(bits)) throw new RangeError(`${where}: out of range for ${type}`);
    return word(v);
  }
  throw new Error(`${where}: unsupported EIP-712 type ${type} (flat structs only)`);
}
function hashFlatStruct(primaryType, fields, data) {
  const parts = [keccak_256(utf8(encodeFlatType(primaryType, fields)))];
  for (const f of fields) {
    if (!(f.name in data)) throw new Error(`${primaryType}.${f.name} is missing`);
    parts.push(encodeField(f.type, data[f.name], `${primaryType}.${f.name}`));
  }
  return keccak_256(concat(...parts));
}
function structDependencies(type, types, found = /* @__PURE__ */ new Set()) {
  if (found.has(type) || !types[type]) return found;
  found.add(type);
  for (const f of types[type]) {
    if (/\[\d*\]$/.test(f.type)) throw new Error(`${type}.${f.name}: EIP-712 arrays are not supported`);
    structDependencies(f.type, types, found);
  }
  return found;
}
function encodeType(primaryType, types) {
  const deps = [...structDependencies(primaryType, types)].filter((t) => t !== primaryType).sort();
  return [primaryType, ...deps].map((t) => encodeFlatType(t, types[t])).join("");
}
function hashStruct(primaryType, types, data) {
  const fields = types[primaryType];
  if (!fields) throw new Error(`typed data has no type ${primaryType}`);
  const parts = [keccak_256(utf8(encodeType(primaryType, types)))];
  for (const f of fields) {
    if (!(f.name in data)) throw new Error(`${primaryType}.${f.name} is missing`);
    const v = data[f.name];
    if (f.type !== primaryType && f.type in types) {
      if (typeof v !== "object" || v === null) throw new TypeError(`${primaryType}.${f.name}: expected a ${f.type} struct`);
      parts.push(hashStruct(f.type, types, v));
    } else {
      parts.push(encodeField(f.type, v, `${primaryType}.${f.name}`));
    }
  }
  return keccak_256(concat(...parts));
}
function hashTypedData(td) {
  const domainFields = td.types["EIP712Domain"] ?? EIP712_DOMAIN_FIELDS;
  const { EIP712Domain: _domain, ...types } = td.types;
  return keccak_256(
    concat(
      new Uint8Array([25, 1]),
      hashFlatStruct("EIP712Domain", domainFields, td.domain),
      hashStruct(td.primaryType, types, td.message)
    )
  );
}
function signDigest(digest, privateKey, sigType) {
  const sig = secp256k1.sign(digest, privateKey, { lowS: true, prehash: false });
  const compact = sig.toCompactRawBytes();
  return concat(new Uint8Array([sigType]), compact, new Uint8Array([sig.recovery & 1]));
}
function recoverAddress(digest, rsv) {
  if (rsv.length !== 65) throw new Error("expected 65-byte signature");
  const v = rsv[64];
  const rec = v >= 27 ? v - 27 : v;
  if (rec !== 0 && rec !== 1) throw new Error(`unexpected recovery id ${v}`);
  const sig = secp256k1.Signature.fromCompact(rsv.slice(0, 64)).addRecoveryBit(rec);
  const pub = sig.recoverPublicKey(digest).toRawBytes(false);
  return bytesToHex2(keccak_256(pub.slice(1)).slice(12));
}
var privateKeyToAddress = (privateKey) => bytesToHex2(keccak_256(secp256k1.getPublicKey(privateKey, false).slice(1)).slice(12));

// packages/sodex-core/src/decimal.ts
var DECIMAL_RE = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;
var DecimalError = class extends Error {
};
function expandExponent(digits, exponent) {
  const neg = digits.startsWith("-");
  if (neg || digits.startsWith("+")) digits = digits.slice(1);
  let [intPart = "", fracPart = ""] = digits.split(".");
  if (exponent > 0) {
    if (fracPart.length <= exponent) {
      intPart += fracPart.padEnd(exponent, "0");
      fracPart = "";
    } else {
      intPart += fracPart.slice(0, exponent);
      fracPart = fracPart.slice(exponent);
    }
  } else if (exponent < 0) {
    const shift = -exponent;
    if (intPart.length <= shift) {
      fracPart = intPart.padStart(shift, "0") + fracPart;
      intPart = "";
    } else {
      fracPart = intPart.slice(intPart.length - shift) + fracPart;
      intPart = intPart.slice(0, intPart.length - shift);
    }
  }
  return (neg ? "-" : "") + (intPart || "0") + (fracPart ? "." + fracPart : "");
}
function canonicalDecimal(input) {
  let s = typeof input === "number" ? numberToPlainString(input) : String(input).trim();
  if (s === "") throw new DecimalError("empty decimal");
  if (!DECIMAL_RE.test(s)) throw new DecimalError(`not a decimal: ${JSON.stringify(s)}`);
  const expMatch = s.match(/[eE]([+-]?\d+)$/);
  if (expMatch) {
    s = expandExponent(s.slice(0, expMatch.index), Number.parseInt(expMatch[1], 10));
  }
  let neg = s.startsWith("-");
  if (neg || s.startsWith("+")) s = s.slice(1);
  let [intPart = "", fracPart = ""] = s.split(".");
  intPart = intPart.replace(/^0+(?=\d)/, "") || "0";
  fracPart = fracPart.replace(/0+$/, "");
  if (intPart === "0" && fracPart === "") neg = false;
  return (neg ? "-" : "") + intPart + (fracPart ? "." + fracPart : "");
}
function numberToPlainString(n) {
  if (!Number.isFinite(n)) throw new DecimalError(`not finite: ${n}`);
  const s = String(n);
  const m = s.match(/^([^eE]+)[eE]([+-]?\d+)$/);
  return m ? expandExponent(m[1], Number.parseInt(m[2], 10)) : s;
}
function decimalCompare(a, b) {
  const [ca, cb] = [canonicalDecimal(a), canonicalDecimal(b)];
  const [na, nb] = [ca.startsWith("-"), cb.startsWith("-")];
  if (na !== nb) return na ? -1 : 1;
  const sign2 = na ? -1 : 1;
  const [ai = "0", af = ""] = (na ? ca.slice(1) : ca).split(".");
  const [bi = "0", bf = ""] = (nb ? cb.slice(1) : cb).split(".");
  if (ai.length !== bi.length) return ai.length > bi.length ? sign2 : -sign2;
  if (ai !== bi) return ai > bi ? sign2 : -sign2;
  const width = Math.max(af.length, bf.length);
  const [ap, bp] = [af.padEnd(width, "0"), bf.padEnd(width, "0")];
  if (ap === bp) return 0;
  return ap > bp ? sign2 : -sign2;
}
function roundToStep(value, step, mode = "nearest") {
  const c = canonicalDecimal(step);
  if (c === "0") return canonicalDecimal(value);
  const scale = Math.max(fracDigits(value), fracDigits(c));
  const v = BigInt(scaleToInt(value, scale));
  const s = BigInt(scaleToInt(c, scale));
  let q = v / s;
  const r = v % s;
  if (mode === "nearest" && r * 2n >= s) q += 1n;
  return unscaleFromInt(q * s, scale);
}
var fracDigits = (v) => (canonicalDecimal(v).split(".")[1] ?? "").length;
function scaleToInt(v, scale) {
  const c = canonicalDecimal(v);
  const neg = c.startsWith("-");
  const [i = "0", f = ""] = (neg ? c.slice(1) : c).split(".");
  return (neg ? "-" : "") + (i + f.padEnd(scale, "0") || "0");
}
function unscaleFromInt(n, scale) {
  const neg = n < 0n;
  let s = (neg ? -n : n).toString().padStart(scale + 1, "0");
  const out = scale === 0 ? s : s.slice(0, s.length - scale) + "." + s.slice(s.length - scale);
  return canonicalDecimal((neg ? "-" : "") + out);
}

// packages/sodex-core/src/actions.ts
var OrderSide = { BUY: 1, SELL: 2 };
var OrderType = { LIMIT: 1, MARKET: 2 };
var TimeInForce = { GTC: 1, FOK: 2, IOC: 3, GTX: 4 };
var MarginMode = { ISOLATED: 1, CROSS: 2 };
var PositionSide = { BOTH: 1, LONG: 2, SHORT: 3 };
var OrderModifier = { NORMAL: 1, STOP: 2, BRACKET: 3, ATTACHED_STOP: 4 };
var StopType = { STOP_LOSS: 1, TAKE_PROFIT: 2 };
var TriggerType = { LAST_PRICE: 1, MARK_PRICE: 2, INDEX_PRICE: 3 };
var CL_ORD_ID_RE = /^[0-9a-zA-Z_-]{1,36}$/;
function assertClOrdID(id) {
  if (!CL_ORD_ID_RE.test(id)) {
    throw new Error(`clOrdID must match ${CL_ORD_ID_RE} (got ${JSON.stringify(id)})`);
  }
  return id;
}
var MAX_ORDERS_PER_BATCH = 100;
var MAX_UINT64 = (1n << 64n) - 1n;
function u64(v, what) {
  if (typeof v === "bigint") {
    if (v < 0n || v > MAX_UINT64) throw new RangeError(`${what} is out of uint64 range`);
    return v;
  }
  if (!Number.isSafeInteger(v) || v < 0) {
    throw new RangeError(`${what} must be a non-negative safe integer (got ${v})`);
  }
  return v;
}
var optU64 = (v, what) => v === void 0 ? void 0 : u64(v, what);
function batch(list, what) {
  if (!Array.isArray(list) || list.length === 0) throw new RangeError(`${what} cannot be empty`);
  if (list.length > MAX_ORDERS_PER_BATCH) {
    throw new RangeError(`${what} has ${list.length} entries; the gateway allows at most ${MAX_ORDERS_PER_BATCH}`);
  }
  return list;
}
var dec = (v) => v === void 0 || v === null || v === "" ? void 0 : canonicalDecimal(v);
var BUILDER_FEE_CAP = { spot: 2e3, perps: 200 };
function builderFragment(b, engine) {
  const id = u64(b.id, "builder.id");
  if (id === 0 || id === 0n) throw new RangeError("builder.id must be non-zero");
  const cap = BUILDER_FEE_CAP[engine];
  if (!Number.isInteger(b.fee) || b.fee < 0 || b.fee > cap) {
    throw new RangeError(`builder.fee must be an integer 0..${cap} for ${engine} (got ${b.fee})`);
  }
  return { id, fee: b.fee };
}
var buildRawOrder = (o) => ({
  clOrdID: assertClOrdID(o.clOrdID),
  modifier: o.modifier ?? OrderModifier.NORMAL,
  side: o.side,
  type: o.type,
  timeInForce: o.timeInForce,
  price: dec(o.price),
  quantity: dec(o.quantity),
  funds: dec(o.funds),
  stopPrice: dec(o.stopPrice),
  stopType: o.stopType,
  triggerType: o.triggerType,
  reduceOnly: o.reduceOnly ?? false,
  positionSide: o.positionSide ?? PositionSide.BOTH,
  builder: o.builder ? builderFragment(o.builder, "perps") : void 0
});
var perpsNewOrder = (accountID, symbolID, orders, builder) => ({
  accountID: u64(accountID, "accountID"),
  symbolID: u64(symbolID, "symbolID"),
  orders: batch(orders, "orders").map(buildRawOrder),
  builder: builder ? builderFragment(builder, "perps") : void 0
});
var perpsCancelOrder = (accountID, cancels) => ({
  accountID: u64(accountID, "accountID"),
  cancels: batch(cancels, "cancels").map((c) => {
    if (c.orderID === void 0 && c.clOrdID === void 0) {
      throw new Error("each cancel needs an orderID or a clOrdID");
    }
    return {
      symbolID: u64(c.symbolID, "symbolID"),
      orderID: optU64(c.orderID, "orderID"),
      clOrdID: c.clOrdID === void 0 ? void 0 : assertClOrdID(c.clOrdID)
    };
  })
});
var perpsModifyOrder = (i) => ({
  accountID: u64(i.accountID, "accountID"),
  symbolID: u64(i.symbolID, "symbolID"),
  orderID: optU64(i.orderID, "orderID"),
  clOrdID: i.clOrdID === void 0 ? void 0 : assertClOrdID(i.clOrdID),
  price: dec(i.price),
  quantity: dec(i.quantity),
  stopPrice: dec(i.stopPrice)
});
var perpsUpdateLeverage = (accountID, symbolID, leverage, marginMode) => ({
  accountID: u64(accountID, "accountID"),
  symbolID: u64(symbolID, "symbolID"),
  leverage: u64(leverage, "leverage"),
  marginMode
});
var perpsUpdateMargin = (accountID, symbolID, amount) => ({
  accountID: u64(accountID, "accountID"),
  symbolID: u64(symbolID, "symbolID"),
  amount: canonicalDecimal(amount)
});
var replaceOrder = (accountID, orders) => ({
  accountID: u64(accountID, "accountID"),
  orders: batch(orders, "orders").map((o) => ({
    symbolID: u64(o.symbolID, "symbolID"),
    clOrdID: assertClOrdID(o.clOrdID),
    origOrderID: optU64(o.origOrderID, "origOrderID"),
    origClOrdID: o.origClOrdID === void 0 ? void 0 : assertClOrdID(o.origClOrdID),
    price: dec(o.price),
    quantity: dec(o.quantity)
  }))
});
var transferAsset = (i) => ({
  id: u64(i.id, "id"),
  fromAccountID: u64(i.fromAccountID, "fromAccountID"),
  toAccountID: u64(i.toAccountID, "toAccountID"),
  coinID: u64(i.coinID, "coinID"),
  amount: canonicalDecimal(i.amount),
  type: i.type
});
var scheduleCancel = (accountID, scheduledTimestamp) => ({
  accountID: u64(accountID, "accountID"),
  scheduledTimestamp: optU64(scheduledTimestamp, "scheduledTimestamp")
});
var newTwapOrder = (i) => {
  if (!Number.isInteger(i.minutes) || i.minutes < 5 || i.minutes > 1440) {
    throw new RangeError(`TWAP minutes must be 5..1440 (got ${i.minutes})`);
  }
  return {
    accountID: u64(i.accountID, "accountID"),
    symbolID: u64(i.symbolID, "symbolID"),
    side: i.side,
    quantity: canonicalDecimal(i.quantity),
    minutes: i.minutes,
    randomize: i.randomize,
    reduceOnly: i.reduceOnly
  };
};
var cancelTwapOrder = (accountID, symbolID, orderID) => ({
  accountID: u64(accountID, "accountID"),
  symbolID: u64(symbolID, "symbolID"),
  orderID: u64(orderID, "orderID")
});
var ENDPOINTS = {
  perps: {
    newOrder: { method: "POST", path: "/trade/orders" },
    cancelOrder: { method: "DELETE", path: "/trade/orders" },
    modifyOrder: { method: "POST", path: "/trade/orders/modify" },
    replaceOrder: { method: "POST", path: "/trade/orders/replace" },
    scheduleCancel: { method: "POST", path: "/trade/orders/schedule-cancel" },
    updateLeverage: { method: "POST", path: "/trade/leverage" },
    updateMargin: { method: "POST", path: "/trade/margin" },
    transferAsset: { method: "POST", path: "/accounts/transfers" },
    newTwapOrder: { method: "POST", path: "/trade/twaps" },
    cancelTwapOrder: { method: "DELETE", path: "/trade/twaps" },
    revokeAPIKey: { method: "DELETE", path: "/accounts/api-keys" }
  },
  spot: {
    batchNewOrder: { method: "POST", path: "/trade/orders/batch" },
    batchCancelOrder: { method: "DELETE", path: "/trade/orders/batch" },
    replaceOrder: { method: "POST", path: "/trade/orders/replace" },
    scheduleCancel: { method: "POST", path: "/trade/orders/schedule-cancel" },
    transferAsset: { method: "POST", path: "/accounts/transfers" },
    newTwapOrder: { method: "POST", path: "/trade/twaps" },
    cancelTwapOrder: { method: "DELETE", path: "/trade/twaps" },
    revokeAPIKey: { method: "DELETE", path: "/accounts/api-keys" }
  }
};
function endpointFor(engine, type) {
  const ep = ENDPOINTS[engine][type];
  if (!ep) throw new Error(`action ${type} does not exist on the ${engine} engine`);
  return ep;
}
var act = (engine, type, params) => {
  endpointFor(engine, type);
  return { engine, type, params };
};
var perpsActions = {
  newOrder: (accountID, symbolID, orders, builder) => act("perps", "newOrder", perpsNewOrder(accountID, symbolID, orders, builder)),
  cancelOrder: (accountID, cancels) => act("perps", "cancelOrder", perpsCancelOrder(accountID, cancels)),
  modifyOrder: (i) => act("perps", "modifyOrder", perpsModifyOrder(i)),
  replaceOrder: (accountID, orders) => act("perps", "replaceOrder", replaceOrder(accountID, orders)),
  scheduleCancel: (accountID, scheduledTimestamp) => act("perps", "scheduleCancel", scheduleCancel(accountID, scheduledTimestamp)),
  updateLeverage: (accountID, symbolID, leverage, marginMode) => act("perps", "updateLeverage", perpsUpdateLeverage(accountID, symbolID, leverage, marginMode)),
  updateMargin: (accountID, symbolID, amount) => act("perps", "updateMargin", perpsUpdateMargin(accountID, symbolID, amount)),
  transferAsset: (i) => act("perps", "transferAsset", transferAsset(i)),
  newTwapOrder: (i) => act("perps", "newTwapOrder", newTwapOrder(i)),
  cancelTwapOrder: (accountID, symbolID, orderID) => act("perps", "cancelTwapOrder", cancelTwapOrder(accountID, symbolID, orderID))
};

// packages/sodex-core/src/keys.ts
function defaultRandom(length) {
  const c = globalThis.crypto;
  if (!c?.getRandomValues) throw new Error("no CSPRNG available (globalThis.crypto.getRandomValues)");
  return c.getRandomValues(new Uint8Array(length));
}
function wrap(privateKey) {
  const key2 = { address: privateKeyToAddress(privateKey) };
  Object.defineProperty(key2, "privateKey", { value: privateKey, enumerable: false, writable: false });
  Object.defineProperty(key2, "toJSON", { value: () => ({ address: key2.address }), enumerable: false });
  return Object.freeze(key2);
}
function generateTradingKey(random = defaultRandom) {
  for (let attempt = 0; attempt < 16; attempt++) {
    const sk = random(32);
    if (sk.length !== 32) throw new Error("random source must return 32 bytes");
    if (secp256k1.utils.isValidPrivateKey(sk)) return wrap(sk);
    sk.fill(0);
  }
  throw new Error("random source produced no valid secp256k1 scalar in 16 attempts");
}
var HOUR_MS = 36e5;
var DAY_MS = 24 * HOUR_MS;
var MAX_TRADING_KEY_TTL_MS = 7 * DAY_MS;
var MIN_TRADING_KEY_TTL_MS = 5 * 6e4;
var isKeyExpired = (expiresAt, now = Date.now()) => !!expiresAt && expiresAt <= now;

// packages/sodex-core/src/nonce.ts
var NONCE_WINDOW = { pastMs: 2 * DAY_MS, futureMs: DAY_MS };
var DEFAULT_NONCE_WINDOW_MARGIN_MS = 6e4;
var NonceWindowError = class extends RangeError {
  name = "NonceWindowError";
};
function nonceWindowProblem(nonce, now, marginMs = DEFAULT_NONCE_WINDOW_MARGIN_MS) {
  const n = BigInt(nonce);
  const t = BigInt(Math.floor(now));
  const lo = t - BigInt(NONCE_WINDOW.pastMs) + BigInt(marginMs);
  const hi = t + BigInt(NONCE_WINDOW.futureMs) - BigInt(marginMs);
  if (n <= lo) return `nonce ${n} is more than 2 days (minus margin) behind the clock`;
  if (n >= hi) return `nonce ${n} is more than 1 day (minus margin) ahead of the clock - check the system clock`;
  return null;
}
function assertNonceInWindow(nonce, now, marginMs = DEFAULT_NONCE_WINDOW_MARGIN_MS) {
  const p = nonceWindowProblem(nonce, now, marginMs);
  if (p) throw new NonceWindowError(p);
  return BigInt(nonce);
}
var nonceKey = (signerAddress, chainId) => `${chainId}:${signerAddress.trim().toLowerCase()}`;
function detectLocks() {
  try {
    const l = globalThis.navigator?.locks;
    return l && typeof l.request === "function" ? l : null;
  } catch {
    return null;
  }
}
function detectStorage() {
  try {
    const s = globalThis.localStorage;
    if (!s) return null;
    const probe = "__sodex_core_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    return s;
  } catch {
    return null;
  }
}
function detectChannel(name) {
  try {
    const BC = globalThis.BroadcastChannel;
    return BC ? new BC(name) : null;
  } catch {
    return null;
  }
}
var defaultSleep = (ms) => new Promise((r) => {
  const st = globalThis.setTimeout;
  if (st) st(r, ms);
  else r();
});
var DIGITS_RE = /^\d{1,20}$/;
var FENCE_SPIN_LIMIT = 1e5;
var Manager = class {
  hwm = /* @__PURE__ */ new Map();
  tails = /* @__PURE__ */ new Map();
  clock;
  margin;
  storage;
  channel;
  locks;
  ns;
  maxFence;
  sleep;
  /** True when the caller injected `sleep` (tests): then the fence never spins. */
  sleepInjected;
  closed = false;
  constructor(o, detect) {
    const now = o.now ?? Date.now;
    const offset = o.clockOffsetMs ?? 0;
    this.clock = () => now() + offset;
    this.margin = o.windowMarginMs ?? DEFAULT_NONCE_WINDOW_MARGIN_MS;
    this.ns = o.namespace ?? "sodex-core.nonce";
    this.maxFence = o.maxFenceWaitMs ?? 5;
    this.sleep = o.sleep ?? defaultSleep;
    this.sleepInjected = o.sleep !== void 0;
    this.storage = o.storage !== void 0 ? o.storage : detect ? detectStorage() : null;
    this.locks = o.locks !== void 0 ? o.locks : detect ? detectLocks() : null;
    this.channel = o.channel !== void 0 ? o.channel : detect ? detectChannel(this.ns) : null;
    this.channel?.addEventListener("message", (ev) => this.onMessage(ev.data));
  }
  get crossTab() {
    return this.locks !== null;
  }
  onMessage(data) {
    if (!data || typeof data !== "object") return;
    const m = data;
    if (m.v !== 1 || typeof m.key !== "string") return;
    if (m.reset === true) {
      this.hwm.delete(m.key);
      return;
    }
    if (typeof m.nonce !== "string" || !DIGITS_RE.test(m.nonce)) return;
    this.bump(m.key, BigInt(m.nonce));
  }
  bump(key2, n) {
    const cur = this.hwm.get(key2);
    if (cur === void 0 || n > cur) this.hwm.set(key2, n);
  }
  storageKey(key2) {
    return `${this.ns}:${key2}`;
  }
  readStored(key2) {
    if (!this.storage) return 0n;
    try {
      const v = this.storage.getItem(this.storageKey(key2));
      return v !== null && DIGITS_RE.test(v) ? BigInt(v) : 0n;
    } catch {
      return 0n;
    }
  }
  writeStored(key2, n) {
    if (!this.storage) return;
    try {
      if (this.readStored(key2) < n) this.storage.setItem(this.storageKey(key2), n.toString());
    } catch {
    }
  }
  /** Serialise `fn` per key: in-realm first, then across tabs via Web Locks. */
  async exclusive(key2, fn) {
    if (this.closed) throw new Error("nonce manager is closed");
    const prev = this.tails.get(key2) ?? Promise.resolve();
    let done;
    const mine = new Promise((r) => done = r);
    const tail = prev.then(() => mine);
    this.tails.set(key2, tail);
    await prev;
    try {
      return this.locks ? await this.locks.request(`${this.ns}:${key2}`, () => fn()) : await fn();
    } finally {
      done();
      if (this.tails.get(key2) === tail) this.tails.delete(key2);
    }
  }
  /** Must run inside `exclusive`. */
  allocate(key2) {
    const now = BigInt(Math.floor(this.clock()));
    let n = now;
    const mem = this.hwm.get(key2);
    if (mem !== void 0 && mem >= n) n = mem + 1n;
    const stored = this.readStored(key2);
    if (stored >= n) n = stored + 1n;
    assertNonceInWindow(n, Number(now), this.margin);
    this.bump(key2, n);
    this.writeStored(key2, n);
    try {
      this.channel?.postMessage({ v: 1, key: key2, nonce: n.toString() });
    } catch {
    }
    return n;
  }
  /** Hold the lock until the clock has passed `n` (bounded; see maxFenceWaitMs). */
  async fence(n) {
    if (this.maxFence <= 0) return;
    const deadline = Number(n);
    const ahead = deadline - Math.floor(this.clock());
    if (ahead < 0 || ahead > this.maxFence) return;
    if (!this.sleepInjected) {
      for (let i = 0; i < FENCE_SPIN_LIMIT && Math.floor(this.clock()) <= deadline; i++) {
      }
    }
    for (let i = 0; i < this.maxFence + 5 && Math.floor(this.clock()) <= deadline; i++) {
      await this.sleep(1);
    }
  }
  next(key2) {
    return this.exclusive(key2, async () => {
      const n = this.allocate(key2);
      await this.fence(n);
      return n;
    });
  }
  withNonce(key2, fn) {
    return this.exclusive(key2, async () => {
      const n = this.allocate(key2);
      try {
        return await fn(n);
      } finally {
        await this.fence(n);
      }
    });
  }
  highWater(key2) {
    const mem = this.hwm.get(key2);
    const stored = this.readStored(key2);
    if (mem === void 0 && stored === 0n) return void 0;
    return mem !== void 0 && mem > stored ? mem : stored;
  }
  reset(key2) {
    this.hwm.delete(key2);
    try {
      this.storage?.removeItem(this.storageKey(key2));
    } catch {
    }
    try {
      this.channel?.postMessage({ v: 1, key: key2, reset: true });
    } catch {
    }
  }
  close() {
    this.closed = true;
    try {
      this.channel?.close();
    } catch {
    }
  }
};
var createMemoryNonceManager = (opts = {}) => new Manager({ ...opts, storage: null, channel: null, locks: null }, false);

// packages/sodex-core/src/request.ts
var HEADER = {
  key: "X-API-Key",
  sign: "X-API-Sign",
  nonce: "X-API-Nonce",
  chain: "X-API-Chain"
};
function signingKeyFrom(key2, registration) {
  const ref = { name: registration.name, expiresAt: registration.expiresAt, address: key2.address.toLowerCase() };
  Object.defineProperty(ref, "privateKey", { value: key2.privateKey, enumerable: false, writable: false });
  return Object.freeze(ref);
}
var SigningError = class extends Error {
  name = "SigningError";
};
var joinBase = (base2, path) => base2.replace(/\/+$/, "") + path;
function signAndBuild(action2, key2, opts) {
  const now = opts.now ?? Date.now();
  if (!Number.isSafeInteger(opts.chainId) || opts.chainId <= 0) {
    throw new SigningError("chainId must be the SoDEX chain id (286623 mainnet, 138565 testnet)");
  }
  if (isKeyExpired(key2.expiresAt, now)) {
    throw new SigningError("This trading key has expired. Register a new one - it takes one wallet signature.");
  }
  if (key2.name !== void 0 && key2.name === "") throw new SigningError("API key name must not be empty");
  const nonce = assertNonceInWindow(opts.nonce, now, opts.nonceWindowMarginMs ?? DEFAULT_NONCE_WINDOW_MARGIN_MS);
  const ep = endpointFor(action2.engine, action2.type);
  const body = goJSONStringify(action2.params);
  const payloadHash = keccak256(utf8(payloadJSONFromBody(action2.type, body)));
  const digest = eip712Digest(
    makeDomain(engineDomainName(action2.engine), opts.chainId),
    exchangeActionStructHash(payloadHash, nonce)
  );
  const signature = bytesToHex2(signDigest(digest, key2.privateKey, SignatureType.EIP712));
  const gatewayPath = enginePath(action2.engine) + ep.path;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json",
    [HEADER.sign]: signature,
    [HEADER.nonce]: nonce.toString(),
    [HEADER.chain]: String(opts.chainId)
  };
  if (key2.name !== void 0) headers[HEADER.key] = key2.name;
  return {
    method: ep.method,
    path: joinBase(opts.base ?? DEFAULT_RELAY_BASE, gatewayPath),
    gatewayPath,
    headers,
    body,
    meta: {
      engine: action2.engine,
      actionType: action2.type,
      nonce: nonce.toString(),
      signer: key2.address?.toLowerCase() ?? privateKeyToAddress(key2.privateKey),
      payloadHash: bytesToHex2(payloadHash),
      digest: bytesToHex2(digest),
      signature
    }
  };
}
async function signAndBuildWithNonceManager(action2, key2, opts) {
  const signer = key2.address ?? privateKeyToAddress(key2.privateKey);
  const nonce = await opts.nonces.next(nonceKey(signer, opts.chainId));
  const ref = { privateKey: key2.privateKey, name: key2.name, expiresAt: key2.expiresAt, address: signer };
  return signAndBuild(action2, ref, { ...opts, nonce });
}

// packages/sodex-core/src/builders.ts
var asRate = (v) => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};
function approvedBuilderRates(data, builderID) {
  const want = String(builderID);
  const out = { spot: null, perps: null };
  if (!data || typeof data !== "object") return out;
  for (const engine of ENGINES) {
    const rows2 = data[engine];
    if (!Array.isArray(rows2)) continue;
    for (const row of rows2) {
      if (!row || typeof row !== "object") continue;
      const r = row;
      if (String(r["builderID"]) !== want) continue;
      const rate = asRate(r["feeRate"]);
      if (rate !== null && (out[engine] === null || rate > out[engine])) out[engine] = rate;
    }
  }
  return out;
}

// packages/sodex-core/src/envelope.ts
var SodexApiError = class extends Error {
  constructor(code, message, httpStatus, path, body) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
    this.path = path;
    this.body = body;
  }
  code;
  httpStatus;
  path;
  body;
  name = "SodexApiError";
  /** Human-actionable hint, mapped from the documented failure modes. */
  get hint() {
    if (/api key not found|key not found|unknown api key/i.test(this.message)) {
      return "This trading key is no longer registered on SoDEX. Enable trading again to mint a new one.";
    }
    if (this.httpStatus === 401 || this.code === 401) {
      return "Signature rejected. Check: X-API-Key header present, signing domain matches the engine (futures vs spot), and the key is registered for this account.";
    }
    if (this.httpStatus === 429 || this.code === 429) return "Rate limited - backing off.";
    if (/nonce/i.test(this.message)) {
      return "Nonce must be a millisecond timestamp inside (now-2d, now+1d), unique, and above the lowest of the last 100 used.";
    }
    if (/builder/i.test(this.message)) {
      return "SoDEX does not list an approval of this builder fee for the account (never approved, revoked, or approved for less). Approve the builder fee again, then place the order again.";
    }
    if (this.httpStatus === 400 || this.code === 400) {
      return "Rejected payload. Common causes: trailing zeros in price/quantity, duplicate clOrdID, or a value outside the symbol tick/step grid.";
    }
    return void 0;
  }
};
function parseEnvelope(httpStatus, text, path = "") {
  const ok = httpStatus >= 200 && httpStatus < 300;
  if (!text && ok) return void 0;
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    throw new SodexApiError(-1, `non-JSON response (HTTP ${httpStatus}): ${text.slice(0, 200)}`, httpStatus, path);
  }
  const obj = parsed && typeof parsed === "object" ? parsed : {};
  const env = obj;
  const errText = env.error ?? env.message ?? env.msg;
  const asserted = env.code === 0;
  const failed = !ok || typeof env.code === "number" && env.code !== 0 || !asserted && (typeof errText === "string" && errText !== "" || !("data" in obj));
  if (failed) {
    const msg = errText ?? `HTTP ${httpStatus}`;
    throw new SodexApiError(typeof env.code === "number" ? env.code : httpStatus, msg, httpStatus, path, parsed);
  }
  return env.data;
}
var failedOrders = (results) => (results ?? []).filter((r) => r && typeof r.code === "number" && r.code !== 0);
function unwrapList(data, key2) {
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const inner = data[key2];
    if (Array.isArray(inner)) return inner;
  }
  return [];
}
var TRANSIENT_ENVELOPE_RE = /internal (server )?error|service unavailable|unavailable|timed? ?out|temporar|try again|too many requests|server busy|unexpected EOF|connection reset/i;
function isTransientFailure(err) {
  if (err instanceof SodexApiError) {
    if (err.httpStatus >= 500) return true;
    if (err.httpStatus === 429 || err.code === 429) return true;
    if (err.httpStatus < 400) return TRANSIENT_ENVELOPE_RE.test(err.message);
    return false;
  }
  if (err instanceof Error) {
    return err.name === "TimeoutError" || err.name === "AbortError" || err.name === "TypeError";
  }
  return false;
}
function weightFor(path, limit = 0) {
  if (/\/markets\/(symbols|tickers|bookTickers|coins|mark-prices)/.test(path)) return 2;
  if (/\/orderbook/.test(path)) return limit > 100 ? 10 : 5;
  if (/\/(klines|trades)/.test(path) && !/accounts/.test(path)) return 20;
  if (/\/(orders\/history|trades|funding-history|fundings|positions\/history)/.test(path)) {
    return 20 + Math.floor(limit / 20);
  }
  if (/\/fee-rate/.test(path)) return 2;
  if (/\/accounts\//.test(path)) return 5;
  return 5;
}

// apps/executor/src/secrets.ts
function secretFile(dir, name) {
  mkdirSync2(dir, { recursive: true, mode: 448 });
  const path = join2(dir, name);
  if (!existsSync(path)) {
    writeFileSync(path, randomBytes2(32), { mode: 384, flag: "wx" });
  }
  try {
    chmodSync(path, 384);
  } catch {
  }
  const b = readFileSync(path);
  if (b.length !== 32) throw new Error(`${path} must hold exactly 32 bytes`);
  return b;
}
var Secrets = class {
  kek;
  sessionKey;
  constructor(dir) {
    this.kek = secretFile(dir, "kek");
    this.sessionKey = secretFile(dir, "session.key");
  }
  /* ---------------------------------------------------------- keys ----- */
  /** A fresh secp256k1 key: its address, and its private key sealed. The plain key is wiped. */
  newKey(network, owner) {
    const k = generateTradingKey((n) => new Uint8Array(randomBytes2(n)));
    try {
      const address = k.address.toLowerCase();
      return { address, sealed: this.seal(network, owner, address, k.privateKey) };
    } finally {
      k.privateKey.fill(0);
    }
  }
  seal(network, owner, address, privateKey) {
    const iv = randomBytes2(12);
    const c = createCipheriv("aes-256-gcm", this.kek, iv);
    c.setAAD(aad(network, owner, address));
    const ct = Buffer.concat([c.update(privateKey), c.final()]);
    return ["v1", iv.toString("base64url"), ct.toString("base64url"), c.getAuthTag().toString("base64url")].join(".");
  }
  /** The signing key for a sealed record. Throws when it does not open, or opens to another address. */
  open(network, owner, address, sealed, registration) {
    const [v, iv, ct, tag] = sealed.split(".");
    if (v !== "v1" || !iv || !ct || !tag) throw new Error("sealed key: unknown format");
    const d = createDecipheriv("aes-256-gcm", this.kek, Buffer.from(iv, "base64url"));
    d.setAAD(aad(network, owner, address));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    const pk = new Uint8Array(Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]));
    if (privateKeyToAddress(pk).toLowerCase() !== address.toLowerCase()) {
      pk.fill(0);
      throw new Error("sealed key: opens to another address");
    }
    return signingKeyFrom({ privateKey: pk, address }, { name: registration.name, expiresAt: registration.expiresAt ?? 0 });
  }
  /* ------------------------------------------------------ sessions ----- */
  issueSession(owner, ttlMs, now = Date.now()) {
    const expiresAt = now + ttlMs;
    const body = `${owner.toLowerCase()}.${expiresAt}`;
    return { token: `${body}.${this.mac(body)}`, expiresAt };
  }
  /** The wallet a token belongs to, or null (forged, expired, malformed). */
  readSession(token, now = Date.now()) {
    if (!token) return null;
    const m = /^(0x[0-9a-f]{40})\.(\d{13})\.([A-Za-z0-9_-]{43})$/.exec(token.trim());
    if (!m) return null;
    const body = `${m[1]}.${m[2]}`;
    const want = Buffer.from(this.mac(body));
    const got = Buffer.from(m[3]);
    if (want.length !== got.length || !timingSafeEqual(want, got)) return null;
    if (Number(m[2]) <= now) return null;
    return m[1];
  }
  mac(body) {
    return createHmac("sha256", this.sessionKey).update(body).digest("base64url");
  }
};
var aad = (network, owner, address) => Buffer.from(`vd-copy-key:v1:${network}:${owner.toLowerCase()}:${address.toLowerCase()}`);

// apps/executor/src/server.ts
import { createServer } from "node:http";
import { timingSafeEqual as timingSafeEqual2 } from "node:crypto";

// packages/copy-engine/src/io.ts
var WS_OPEN = 1;
var host = globalThis;
function unref(h) {
  h?.unref?.();
  return h;
}
var timers = {
  after: (ms, fn) => unref(host.setTimeout(fn, ms)),
  every: (ms, fn) => unref(host.setInterval(fn, ms)),
  cancel: (h) => {
    if (h !== void 0 && h !== null) {
      host.clearTimeout(h);
      host.clearInterval(h);
    }
  }
};
var sleep = (ms) => new Promise((r) => timers.after(ms, r));
function abortController() {
  const C = globalThis.AbortController;
  return C ? new C() : { signal: void 0, abort() {
  } };
}
function randomBytes3(n) {
  const c = globalThis.crypto;
  if (!c) throw new Error("no secure random source");
  return c.getRandomValues(new Uint8Array(n));
}
function randomId(prefix = "") {
  const b = randomBytes3(10);
  let s = "";
  for (const x of b) s += x.toString(36).padStart(2, "0");
  return prefix + s.slice(0, 16);
}

// packages/copy-engine/src/policy.ts
var COPY_TERMS_VERSION = "2026-10-23.2";
var US_REGIONS = ["US", "PR", "VI", "GU", "AS", "MP", "UM"];
var SANCTIONED = ["CU", "IR", "KP", "SY", "RU", "BY", "MM"];
var BLOCKED_COUNTRIES = [...US_REGIONS, ...SANCTIONED];
var EEA_COUNTRIES = [
  "AT",
  "BE",
  "BG",
  "HR",
  "CY",
  "CZ",
  "DK",
  "EE",
  "FI",
  "FR",
  "DE",
  "GR",
  "HU",
  "IE",
  "IT",
  "LV",
  "LT",
  "LU",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SK",
  "SI",
  "ES",
  "SE",
  "IS",
  "LI",
  "NO"
];
var EEA_MAX_LEVERAGE = 2;
var ABSOLUTE_MAX_LEVERAGE = 50;
var ISO2 = /^[A-Z]{2}$/;
function normaliseCountry(c) {
  if (typeof c !== "string") return null;
  const t = c.trim().toUpperCase();
  if (!ISO2.test(t) || t === "XX" || t === "ZZ") return null;
  return t;
}
var regionOf = (country) => country === null ? "other" : BLOCKED_COUNTRIES.includes(country) ? "blocked" : EEA_COUNTRIES.includes(country) ? "eea" : "other";
var RANK = { blocked: 2, eea: 1, other: 0 };
function regionPolicy(declared, observed) {
  const d = normaliseCountry(declared);
  const o = normaliseCountry(observed ?? null);
  const mismatch = d !== null && o !== null && d !== o;
  if (d === null) {
    return { region: "blocked", allowed: false, maxLeverage: null, reason: "Choose your country of residence to copy trades.", country: null, mismatch };
  }
  const rd = regionOf(d);
  const ro = o === null ? "other" : regionOf(o);
  const region = RANK[ro] > RANK[rd] ? ro : rd;
  const country = RANK[ro] > RANK[rd] ? o : d;
  if (region === "blocked") {
    const us = country !== null && US_REGIONS.includes(country);
    return {
      region,
      allowed: false,
      maxLeverage: null,
      reason: us ? "Copy trading is not available to residents of the United States or its territories, or to anyone connecting from there." : "Copy trading is not available in your country or from where you are connecting.",
      country,
      mismatch
    };
  }
  if (region === "eea") {
    return {
      region,
      allowed: true,
      maxLeverage: EEA_MAX_LEVERAGE,
      reason: `In the EU and EEA, copies are limited to ${EEA_MAX_LEVERAGE}x leverage (the retail limit for leveraged crypto products).`,
      country,
      mismatch
    };
  }
  return { region, allowed: true, maxLeverage: null, reason: null, country, mismatch };
}
function effectiveLeverage(settingsMax, policy, marketMax) {
  let lev = Math.min(settingsMax, ABSOLUTE_MAX_LEVERAGE);
  if (policy.maxLeverage !== null) lev = Math.min(lev, policy.maxLeverage);
  if (marketMax !== void 0 && Number.isFinite(marketMax) && marketMax > 0) lev = Math.min(lev, marketMax);
  return Math.max(1, Math.floor(lev));
}
var COPY_FEE_LADDER = [
  { fromUsd: 0, fee: 25 },
  { fromUsd: 1e5, fee: 20 },
  { fromUsd: 5e5, fee: 15 },
  { fromUsd: 2e6, fee: 12 },
  { fromUsd: 1e7, fee: 10 }
];
var COPY_FEE_WINDOW_DAYS = 14;
var COPY_FEE_MAX = COPY_FEE_LADDER[0].fee;
function copyFeeFor(volumeUsd, ladder = COPY_FEE_LADDER) {
  let fee = ladder[0].fee;
  if (typeof volumeUsd !== "number" || !Number.isFinite(volumeUsd)) return fee;
  for (const step of ladder) if (volumeUsd >= step.fromUsd) fee = step.fee;
  return fee;
}

// packages/copy-engine/src/settings.ts
var ADDRESS2 = /^0x[0-9a-f]{40}$/;
var COIN = /^[A-Z0-9]{1,20}$/;
var DEFAULT_SETTINGS = {
  direction: "copy",
  sizingMode: "proportional",
  allocationUsd: 1e3,
  ratio: 0.1,
  fixedNotionalUsd: 100,
  maxLeverage: 5,
  maxPositionUsd: 2500,
  stopLossPct: 0.5,
  takeProfitPct: null,
  drawdownStopPct: 0.3,
  assetAllow: [],
  assetDeny: [],
  copyExisting: false,
  slippageBps: 50,
  marginMode: "isolated",
  approval: "auto",
  paper: false
};
var LIMITS = {
  allocationUsd: { min: 10, max: 1e7 },
  ratio: { min: 1e-4, max: 10 },
  fixedNotionalUsd: { min: 10, max: 1e6 },
  maxLeverage: { min: 1, max: 50 },
  maxPositionUsd: { min: 10, max: 1e7 },
  stopLossPct: { min: 0.01, max: 1 },
  takeProfitPct: { min: 0.01, max: 100 },
  drawdownStopPct: { min: 0.01, max: 1 },
  slippageBps: { min: 1, max: 500 },
  coins: 100
};
var VENUES = ["sodex", "hyperliquid"];
var MODES = ["proportional", "fixedRatio", "fixedNotional"];
var DIRECTIONS = ["copy", "counter"];
function numberIn(v, lim, label, errors, field) {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    errors[field] = `${label} must be a number.`;
    return NaN;
  }
  if (n < lim.min || n > lim.max) errors[field] = `${label} must be between ${lim.min} and ${lim.max}.`;
  return n;
}
function optionalIn(v, lim, label, errors, field) {
  if (v === null || v === void 0 || v === "") return null;
  return numberIn(v, lim, label, errors, field);
}
function coins(v, label, errors, field) {
  if (v === void 0 || v === null) return [];
  const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,;]+/) : null;
  if (!list) {
    errors[field] = `${label} must be a list of coins.`;
    return [];
  }
  const out = [...new Set(list.map((c) => String(c).trim().toUpperCase()).filter(Boolean))].sort();
  if (out.length > LIMITS.coins) errors[field] = `${label} can name at most ${LIMITS.coins} coins.`;
  const bad = out.find((c) => !COIN.test(c));
  if (bad) errors[field] = `${label}: "${bad}" is not a coin symbol.`;
  return out;
}
function checkSettings(input) {
  const errors = {};
  const s = input && typeof input === "object" ? input : {};
  const leaderIn = s.leader && typeof s.leader === "object" ? s.leader : {};
  const address = typeof leaderIn.address === "string" ? leaderIn.address.trim().toLowerCase() : "";
  if (!ADDRESS2.test(address)) errors["leader.address"] = "The trader to copy must be a 0x address.";
  const venue = leaderIn.venue;
  if (!VENUES.includes(venue)) errors["leader.venue"] = "The trader must be on SoDEX or Hyperliquid.";
  const pick = (k) => k in s ? s[k] : DEFAULT_SETTINGS[k];
  const direction = (s.direction ?? null) === null ? DEFAULT_SETTINGS.direction : s.direction;
  if (!DIRECTIONS.includes(direction)) errors.direction = "Choose copy or counter-trade.";
  const sizingMode = pick("sizingMode");
  if (!MODES.includes(sizingMode)) errors.sizingMode = "Choose proportional, fixed ratio or fixed amount.";
  const allocationUsd = numberIn(pick("allocationUsd"), LIMITS.allocationUsd, "Allocation", errors, "allocationUsd");
  const ratio = numberIn(pick("ratio"), LIMITS.ratio, "Ratio", errors, "ratio");
  const fixedNotionalUsd = numberIn(pick("fixedNotionalUsd"), LIMITS.fixedNotionalUsd, "Amount per trade", errors, "fixedNotionalUsd");
  const maxLeverage = numberIn(pick("maxLeverage"), LIMITS.maxLeverage, "Max leverage", errors, "maxLeverage");
  const maxPositionUsd = numberIn(pick("maxPositionUsd"), LIMITS.maxPositionUsd, "Max position", errors, "maxPositionUsd");
  const stopLossPct = optionalIn(pick("stopLossPct"), LIMITS.stopLossPct, "Stop loss", errors, "stopLossPct");
  const takeProfitPct = optionalIn(pick("takeProfitPct"), LIMITS.takeProfitPct, "Take profit", errors, "takeProfitPct");
  const drawdownStopPct = optionalIn(pick("drawdownStopPct"), LIMITS.drawdownStopPct, "Drawdown stop", errors, "drawdownStopPct");
  const slippageBps = numberIn(pick("slippageBps"), LIMITS.slippageBps, "Slippage cap", errors, "slippageBps");
  const assetAllow = coins(pick("assetAllow"), "Coins to copy", errors, "assetAllow");
  const assetDeny = coins(pick("assetDeny"), "Coins never to copy", errors, "assetDeny");
  const both = assetAllow.filter((c) => assetDeny.includes(c));
  if (both.length) errors.assetDeny = `${both.join(", ")} is on both lists.`;
  const marginMode = pick("marginMode");
  if (marginMode !== "isolated" && marginMode !== "cross") errors.marginMode = "Margin must be isolated or cross.";
  const approval = pick("approval");
  if (approval !== "auto" && approval !== "confirm") errors.approval = "Approval must be automatic or ask each time.";
  const copyExisting = pick("copyExisting");
  if (typeof copyExisting !== "boolean") errors.copyExisting = "Copy existing positions must be yes or no.";
  const paper = pick("paper");
  if (typeof paper !== "boolean") errors.paper = "Paper copy must be yes or no.";
  if (Object.keys(errors).length) return { settings: null, errors };
  return {
    settings: {
      leader: { venue, address },
      direction,
      sizingMode,
      allocationUsd,
      ratio,
      fixedNotionalUsd,
      maxLeverage: Math.floor(maxLeverage),
      maxPositionUsd,
      stopLossPct,
      takeProfitPct,
      drawdownStopPct,
      assetAllow,
      assetDeny,
      copyExisting,
      slippageBps,
      marginMode,
      approval,
      paper
    },
    errors: {}
  };
}
function parseSettings(input) {
  const r = checkSettings(input);
  if (!r.settings) {
    const msg = Object.entries(r.errors).map(([k, v]) => `${k}: ${v}`).join(" ");
    throw new SettingsError(msg || "Invalid copy settings.", r.errors);
  }
  return r.settings;
}
var SettingsError = class extends Error {
  constructor(message, fields) {
    super(message);
    this.fields = fields;
  }
  fields;
  name = "SettingsError";
};

// packages/copy-engine/src/markets.ts
var num = (v, fallback = NaN) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : fallback;
};
var str = (v, fallback) => typeof v === "string" && v.trim() !== "" ? v.trim() : fallback;
function parseMarkets(rows2) {
  if (!Array.isArray(rows2)) return [];
  const out = [];
  for (const r of rows2) {
    const id = num(r.id);
    const name = str(r.name, "");
    const step = str(r.stepSize, "");
    const tick = str(r.tickSize, "");
    if (!Number.isSafeInteger(id) || !name || !step || !tick || num(step) <= 0 || num(tick) <= 0) continue;
    out.push({
      id,
      name,
      base: str(r.baseCoin, name.replace(/-USD$/, "")).toUpperCase(),
      tickSize: canonicalDecimal(tick),
      stepSize: canonicalDecimal(step),
      minQuantity: canonicalDecimal(str(r.minQuantity, step)),
      maxQuantity: canonicalDecimal(str(r.maxQuantity, "0")),
      marketMaxQuantity: typeof r.marketMaxQuantity === "string" ? canonicalDecimal(r.marketMaxQuantity) : null,
      minNotional: num(r.minNotional, 10),
      maxNotional: num(r.maxNotional) > 0 ? num(r.maxNotional) : null,
      maxLeverage: Math.max(1, Math.floor(num(r.maxLeverage, 1))),
      buyLimitUpRatio: num(r.buyLimitUpRatio, 0.05),
      sellLimitDownRatio: num(r.sellLimitDownRatio, 0.05),
      takerFee: num(r.takerFee, 4e-4),
      ...Number.isFinite(num(r.makerFee)) ? { makerFee: num(r.makerFee) } : {},
      status: str(r.status, "TRADING")
    });
  }
  return out;
}
var MarketBook = class {
  byName = /* @__PURE__ */ new Map();
  marks = /* @__PURE__ */ new Map();
  loadedAt = 0;
  load(markets, now = Date.now()) {
    this.byName = new Map(markets.map((m) => [m.name.toUpperCase(), m]));
    this.loadedAt = now;
  }
  get size() {
    return this.byName.size;
  }
  all() {
    return [...this.byName.values()];
  }
  get(name) {
    return this.byName.get(name.toUpperCase()) ?? null;
  }
  setMark(symbol2, price2, at = Date.now()) {
    if (Number.isFinite(price2) && price2 > 0) this.marks.set(symbol2.toUpperCase(), { price: price2, at });
  }
  /** The mark, if seen within `maxAgeMs`. */
  mark(symbol2, maxAgeMs = 6e4, now = Date.now()) {
    const m = this.marks.get(symbol2.toUpperCase());
    return m && now - m.at <= maxAgeMs ? m.price : null;
  }
  /** The SoDEX market a leader's market maps to, or null when SoDEX lists none. */
  sodexMarketFor(venue, leaderSymbol) {
    for (const name of candidateNames(venue, leaderSymbol)) {
      const hit = this.get(name);
      if (hit) return hit;
    }
    return null;
  }
};
function coinOf(venue, leaderSymbol) {
  const s = leaderSymbol.trim();
  if (venue === "sodex") return s.replace(/-USD$/i, "").toUpperCase();
  const bare = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
  return bare.replace(/^k(?=[A-Z])/, "").toUpperCase();
}
function isSpotSymbol(venue, leaderSymbol) {
  if (venue === "sodex") return leaderSymbol.includes("_") || /^v[A-Z]/.test(leaderSymbol);
  return leaderSymbol.startsWith("@") || leaderSymbol.includes("/");
}
function candidateNames(venue, leaderSymbol) {
  const s = leaderSymbol.trim();
  if (venue === "sodex") return [s];
  const bare = s.includes(":") ? s.slice(s.indexOf(":") + 1) : s;
  const k = /^k([A-Z0-9]+)$/.exec(bare);
  if (k) return [`1000${k[1]}-USD`, `K${k[1]}-USD`, `${bare.toUpperCase()}-USD`];
  return [`${bare.toUpperCase()}-USD`];
}
var toDec = (n) => canonicalDecimal(numberToPlainString(Number(n.toPrecision(12))));
function addStep(value, step) {
  const scale = Math.max((value.split(".")[1] ?? "").length, (step.split(".")[1] ?? "").length);
  const scaled = (v) => {
    const [i = "0", f = ""] = v.split(".");
    return BigInt(i + f.padEnd(scale, "0"));
  };
  const sum = (scaled(value) + scaled(step)).toString().padStart(scale + 1, "0");
  return canonicalDecimal(scale === 0 ? sum : `${sum.slice(0, -scale)}.${sum.slice(-scale)}`);
}
function floorQuantity(size, m) {
  const a = Math.abs(size);
  if (!(a > 0) || !Number.isFinite(a)) return "0";
  return roundToStep(toDec(a), m.stepSize, "floor");
}
function quantityOk(q, m) {
  return q !== "0" && decimalCompare(q, m.minQuantity) >= 0;
}
function limitPrice(side, ref, slippageBps, m, mark) {
  const slip = slippageBps / 1e4;
  let p = side === "buy" ? ref * (1 + slip) : ref * (1 - slip);
  const anchor = mark ?? ref;
  if (side === "buy") p = Math.min(p, anchor * (1 + m.buyLimitUpRatio * 0.98));
  else p = Math.max(p, anchor * (1 - m.sellLimitDownRatio * 0.98));
  if (!(p > 0)) p = Number(m.tickSize);
  const floored = roundToStep(toDec(p), m.tickSize, "floor");
  if (side === "buy") return floored === "0" ? m.tickSize : floored;
  return decimalCompare(floored, toDec(p)) < 0 ? addStep(floored, m.tickSize) : floored;
}
var snapPrice = (p, m) => {
  const s = roundToStep(toDec(Math.max(p, 0)), m.tickSize, "nearest");
  return s === "0" ? m.tickSize : s;
};

// packages/copy-engine/src/planner.ts
var FLAT_EPS = 1e-9;
var isFlat = (x) => !Number.isFinite(x) || Math.abs(x) < FLAT_EPS;
var sign = (x) => isFlat(x) ? 0 : x > 0 ? 1 : -1;
function clientOrderId(subId, eventId, leg) {
  return `vdc-${bytesToHex2(keccak256(utf8(`${subId}|${eventId}|${leg}`))).slice(2, 26)}`;
}
function unrealized(state, markOf) {
  let u = 0;
  for (const [sym, p] of Object.entries(state.owned)) {
    const m = markOf(sym);
    if (m !== null) u += p.size * (m - p.entry);
  }
  return u;
}
function copyEquity(settings, state, markOf) {
  return Math.max(0, settings.allocationUsd + state.realizedPnl - state.fees + unrealized(state, markOf));
}
function grossNotional(state, markOf, except) {
  let g = 0;
  for (const [sym, p] of Object.entries(state.owned)) {
    if (sym === except) continue;
    g += Math.abs(p.size) * (markOf(sym) ?? p.entry);
  }
  return g;
}
var noPlan = (leaderAfter, skip, extra = {}) => ({
  intents: [],
  skip,
  leaderAfter,
  detach: null,
  attach: false,
  ...extra
});
var DETACH_SKIP = {
  "pre-existing": "pre-existing-position",
  "stop-loss": "after-stop-loss",
  "take-profit": "after-take-profit",
  "own-position": "own-position"
};
function targetNotional(s, lSize, lPrice, equity, leaderEquity) {
  if (isFlat(lSize)) return 0;
  const lNotional = lSize * lPrice;
  if (s.sizingMode === "proportional") {
    if (leaderEquity === null || !(leaderEquity > 0)) return null;
    return lNotional * equity / leaderEquity;
  }
  if (s.sizingMode === "fixedRatio") return lNotional * s.ratio;
  return sign(lSize) * s.fixedNotionalUsd;
}
var directionSign = (s) => s.direction === "counter" ? -1 : 1;
function planLeaderEvent(ctx) {
  const { sub, state, event, market } = ctx;
  const s = sub.settings;
  const lSym = event.symbol;
  const realAfter = isFlat(event.after) ? 0 : event.after;
  const dir = directionSign(s);
  const lBefore = dir * (event.before ?? state.leaderPos[lSym] ?? 0);
  const lAfter = dir * realAfter;
  const none = (skip2, extra = {}) => noPlan(realAfter, skip2, extra);
  if (state.seen.includes(event.id)) return none("duplicate");
  if (isSpotSymbol(s.leader.venue, lSym)) return none("spot-not-copied");
  if (!market) return none("not-on-sodex");
  if (sub.status === "paused") return none("paused");
  if (sub.status !== "active") return none("halted");
  if (market.status !== "TRADING") return none("market-halted");
  const owned = state.owned[market.name];
  const F = owned?.size ?? 0;
  const detached = state.detached[lSym];
  let attach = false;
  let before = lBefore;
  if (detached) {
    if (lAfter === 0) return none(DETACH_SKIP[detached], { attach: true });
    if (sign(lBefore) * sign(lAfter) < 0 && isFlat(F)) {
      attach = true;
      before = 0;
    } else {
      return none(DETACH_SKIP[detached]);
    }
  }
  const coin = coinOf(s.leader.venue, lSym);
  const filtered = s.assetAllow.length > 0 && !s.assetAllow.includes(coin) ? "asset-not-allowed" : s.assetDeny.includes(coin) ? "asset-denied" : null;
  const ref = ctx.markOf(market.name) ?? (s.leader.venue === "sodex" && event.price > 0 ? event.price : null);
  if (ref === null) return none("no-price", { attach });
  const equity = copyEquity(s, state, ctx.markOf);
  const lev = effectiveLeverage(s.maxLeverage, ctx.policy, market.maxLeverage);
  const levNoRegion = effectiveLeverage(s.maxLeverage, { maxLeverage: null }, market.maxLeverage);
  const intents = [];
  let skip = null;
  const reduce = (to, leg) => {
    const exact = isFlat(to);
    const q = floorQuantity(exact ? F : F - to, market);
    if (q === "0") {
      skip = "lot-size";
      return;
    }
    const side = F > 0 ? "sell" : "buy";
    intents.push({
      symbol: market.name,
      side,
      quantity: q,
      limitPrice: limitPrice(side, ref, s.slippageBps, market, ctx.markOf(market.name)),
      reduceOnly: true,
      leg,
      notionalUsd: Number(q) * ref,
      clampedBy: null,
      clOrdID: clientOrderId(sub.id, event.id, leg)
    });
  };
  const grow = (from, desired, leg) => {
    if (filtered) {
      skip = filtered;
      return;
    }
    if (isFlat(from) && ctx.heldBy !== "nobody") {
      skip = ctx.heldBy === "other-copy" ? "owned-by-other-copy" : "own-position";
      return;
    }
    let target = Math.abs(desired);
    let clampedBy = null;
    const capPos = s.maxPositionUsd / ref;
    if (target > capPos) {
      target = capPos;
      clampedBy = "max-position";
    }
    const room = (lev * equity - grossNotional(state, ctx.markOf, market.name)) / ref;
    const roomNoRegion = (levNoRegion * equity - grossNotional(state, ctx.markOf, market.name)) / ref;
    if (target > room) {
      clampedBy = room < roomNoRegion && target <= roomNoRegion ? "region-leverage" : "max-leverage";
      target = Math.max(0, room);
    }
    let delta = target - Math.abs(from);
    if (!(delta > 0)) {
      skip = clampedBy ?? "at-target";
      return;
    }
    if (market.maxNotional !== null && delta * ref > market.maxNotional) delta = market.maxNotional / ref;
    const maxQ = Number(market.maxQuantity);
    if (maxQ > 0 && delta > maxQ) delta = maxQ;
    const q = floorQuantity(delta, market);
    if (!quantityOk(q, market)) {
      skip = clampedBy ?? "lot-size";
      return;
    }
    const notional = Number(q) * ref;
    if (notional < market.minNotional) {
      skip = clampedBy ?? "min-notional";
      return;
    }
    const side = desired > 0 ? "buy" : "sell";
    intents.push({
      symbol: market.name,
      side,
      quantity: q,
      limitPrice: limitPrice(side, ref, s.slippageBps, market, ctx.markOf(market.name)),
      reduceOnly: false,
      leg,
      notionalUsd: notional,
      clampedBy,
      clOrdID: clientOrderId(sub.id, event.id, leg)
    });
  };
  const T = (l) => {
    const n = targetNotional(s, l, event.price > 0 ? event.price : ref, equity, state.leaderEquity);
    return n === null ? null : n / ref;
  };
  if (lAfter === 0) {
    if (isFlat(F)) return none("no-follower-position", { attach });
    reduce(0, "close");
  } else if (sign(before) * sign(lAfter) < 0) {
    if (!isFlat(F)) reduce(0, "flip-close");
    const t = T(lAfter);
    if (t === null) skip = skip ?? "no-leader-equity";
    else grow(0, t, "flip-open");
  } else if (isFlat(before)) {
    const t = T(lAfter);
    if (t === null) return none("no-leader-equity", { attach });
    if (!isFlat(F) && sign(F) !== sign(t)) {
      reduce(0, "flip-close");
      grow(0, t, "flip-open");
    } else grow(F, t, "open");
  } else if (Math.abs(lAfter) > Math.abs(before)) {
    let t;
    if (s.sizingMode === "fixedNotional" && !isFlat(F)) t = F * Math.abs(lAfter) / Math.abs(before);
    else t = T(lAfter);
    if (t === null) return none("no-leader-equity", { attach });
    if (isFlat(F) || sign(F) === sign(t)) {
      if (Math.abs(t) <= Math.abs(F)) skip = "at-target";
      else grow(F, t, "increase");
    } else {
      reduce(0, "flip-close");
      grow(0, t, "flip-open");
    }
  } else if (Math.abs(lAfter) < Math.abs(before)) {
    if (isFlat(F)) return none("no-follower-position", { attach });
    const to = F * Math.abs(lAfter) / Math.abs(before);
    reduce(to, "decrease");
  } else {
    skip = "at-target";
  }
  return { intents, skip: intents.length ? skip : skip ?? "at-target", leaderAfter: realAfter, detach: null, attach };
}
function planGuards(ctx) {
  const s = ctx.sub.settings;
  const equity = copyEquity(s, ctx.state, ctx.markOf);
  const peak = Math.max(ctx.state.peakEquity, equity);
  const intents = [];
  const closed = {};
  if (ctx.sub.status !== "active" && ctx.sub.status !== "paused") return { intents, closed, halt: null, equity, peak };
  const closeLeg = (sym, leg, tag) => {
    const p = ctx.state.owned[sym];
    const m = ctx.markets(sym);
    const mark = ctx.markOf(sym);
    if (!p || !m || mark === null || isFlat(p.size)) return false;
    const q = floorQuantity(p.size, m);
    if (q === "0") return false;
    const side = p.size > 0 ? "sell" : "buy";
    intents.push({
      symbol: sym,
      side,
      quantity: q,
      limitPrice: limitPrice(side, mark, Math.max(s.slippageBps, 100), m, mark),
      reduceOnly: true,
      leg,
      notionalUsd: Number(q) * mark,
      clampedBy: null,
      clOrdID: clientOrderId(ctx.sub.id, tag, leg)
    });
    return true;
  };
  if (s.drawdownStopPct !== null && peak > 0 && (peak - equity) / peak >= s.drawdownStopPct) {
    const tag = `dd:${Math.floor(ctx.now / 6e4)}`;
    for (const sym of Object.keys(ctx.state.owned)) closeLeg(sym, "drawdown-stop", `${tag}:${sym}`);
    return { intents, closed, halt: "drawdown-stop", equity, peak };
  }
  for (const [sym, p] of Object.entries(ctx.state.owned)) {
    const m = ctx.markets(sym);
    const mark = ctx.markOf(sym);
    if (!m || mark === null || isFlat(p.size)) continue;
    const lev = effectiveLeverage(s.maxLeverage, ctx.policy, m.maxLeverage);
    const move = sign(p.size) * (mark - p.entry) / p.entry;
    const onMargin = move * lev;
    const tag = `g:${sym}:${p.openedAt}`;
    if (s.stopLossPct !== null && onMargin <= -s.stopLossPct) {
      if (closeLeg(sym, "stop-loss", tag)) closed[sym] = "stop-loss";
    } else if (s.takeProfitPct !== null && onMargin >= s.takeProfitPct) {
      if (closeLeg(sym, "take-profit", tag)) closed[sym] = "take-profit";
    }
  }
  return { intents, closed, halt: null, equity, peak };
}
function guardTrigger(kind, p, settings, leverage) {
  const pct = kind === "stop-loss" ? settings.stopLossPct : settings.takeProfitPct;
  if (pct === null || isFlat(p.size) || !(p.entry > 0)) return null;
  const dir = kind === "stop-loss" ? -1 : 1;
  const px = p.entry * (1 + sign(p.size) * dir * pct / Math.max(1, leverage));
  return px > 0 ? px : null;
}
function freshState(subId, allocationUsd) {
  return {
    subId,
    leaderPos: {},
    leaderEquity: null,
    leaderEquityAt: null,
    owned: {},
    detached: {},
    stops: {},
    realizedPnl: 0,
    fees: 0,
    peakEquity: allocationUsd,
    seen: [],
    lastEventAt: null,
    lastReconcileAt: null,
    orders: 0,
    skips: 0
  };
}
function noteSeen(state, id, cap = 500) {
  state.seen.push(id);
  if (state.seen.length > cap) state.seen.splice(0, state.seen.length - cap);
}
function applyFill(state, symbol2, side, qty2, price2, fee, at) {
  if (!(qty2 > 0) || !(price2 > 0)) return;
  const d = side === "buy" ? qty2 : -qty2;
  const p = state.owned[symbol2];
  const size = p?.size ?? 0;
  state.fees += Math.max(0, fee);
  if (isFlat(size) || sign(size) === sign(d)) {
    const next2 = size + d;
    const entry = isFlat(size) ? price2 : (p.entry * Math.abs(size) + price2 * Math.abs(d)) / Math.abs(next2);
    state.owned[symbol2] = { size: next2, entry, openedAt: p?.openedAt ?? at };
    return;
  }
  const closing = Math.min(Math.abs(d), Math.abs(size));
  state.realizedPnl += closing * (price2 - p.entry) * sign(size);
  const next = size + d;
  if (isFlat(next) || Math.abs(next) < 1e-12) delete state.owned[symbol2];
  else if (sign(next) === sign(size)) state.owned[symbol2] = { size: next, entry: p.entry, openedAt: p.openedAt };
  else state.owned[symbol2] = { size: next, entry: price2, openedAt: at };
}

// packages/copy-engine/src/sodex.ts
var OutcomeUnknownError = class extends Error {
  name = "OutcomeUnknownError";
  outcomeUnknown = true;
};
var WeightBudget = class {
  constructor(perMinute = 1200, readShare = 0.8) {
    this.perMinute = perMinute;
    this.readShare = readShare;
  }
  perMinute;
  readShare;
  spent = [];
  used(now = Date.now()) {
    while (this.spent.length && now - this.spent[0].at >= 6e4) this.spent.shift();
    return this.spent.reduce((a, b) => a + b.w, 0);
  }
  /** Book `w` now (writes never wait). */
  charge(w, now = Date.now()) {
    this.spent.push({ at: now, w });
  }
  /** Wait until a read of weight `w` fits under the read share, then book it. */
  async take(w) {
    for (let i = 0; i < 120; i++) {
      const now = Date.now();
      if (this.used(now) + w <= this.perMinute * this.readShare) {
        this.charge(w, now);
        return;
      }
      const oldest = this.spent[0];
      await sleep(oldest ? Math.max(50, 6e4 - (now - oldest.at) + 5) : 250);
    }
    throw new SodexApiError(429, "local read budget exhausted", 429, "");
  }
};
var SodexClient = class {
  network;
  gateway;
  budget;
  fetch;
  readTimeoutMs;
  writeTimeoutMs;
  constructor(o) {
    this.network = o.network;
    this.gateway = (o.gateway ?? GATEWAY_ORIGIN[o.network]).replace(/\/+$/, "");
    this.fetch = o.fetch;
    this.budget = o.budget ?? new WeightBudget();
    this.readTimeoutMs = o.readTimeoutMs ?? 1e4;
    this.writeTimeoutMs = o.writeTimeoutMs ?? 15e3;
  }
  /** An unsigned GET, budgeted and retried on transient failures. */
  async get(path, weight = weightFor(path), attempts = 3) {
    let last;
    for (let i = 1; i <= attempts; i++) {
      await this.budget.take(weight);
      const ctl = abortController();
      const timer = timers.after(this.readTimeoutMs, () => ctl.abort());
      try {
        const res = await this.fetch(this.gateway + path, { method: "GET", headers: { Accept: "application/json" }, signal: ctl.signal });
        const text = await res.text();
        return parseEnvelope(res.status, text, path);
      } catch (e) {
        last = e;
        if (i >= attempts || !isTransientFailure(e)) throw e;
        await sleep(300 * 2 ** (i - 1));
      } finally {
        timers.cancel(timer);
      }
    }
    throw last;
  }
  /** Send one signed request, once. */
  async send(req) {
    this.budget.charge(1);
    const ctl = abortController();
    const timer = timers.after(this.writeTimeoutMs, () => ctl.abort());
    let res;
    try {
      res = await this.fetch(this.gateway + req.gatewayPath, { method: req.method, headers: req.headers, body: req.body, signal: ctl.signal });
    } catch (e) {
      throw new OutcomeUnknownError(`SoDEX did not answer (${String(e).slice(0, 120)}); the request may still have executed.`);
    } finally {
      timers.cancel(timer);
    }
    const text = await res.text().catch(() => "");
    const unreadable = res.status < 400 && text.trim() !== "" && !/^[\[{]/.test(text.trim());
    if (res.status >= 500 || unreadable) {
      throw new OutcomeUnknownError(`SoDEX answered HTTP ${res.status} after receiving the request; it may still have executed.`);
    }
    return parseEnvelope(res.status, text, req.gatewayPath);
  }
  async markets() {
    return parseMarkets(await this.get("/api/v1/perps/markets/symbols"));
  }
  async markPrices() {
    const rows2 = await this.get("/api/v1/perps/markets/mark-prices");
    return (rows2 ?? []).map((r) => ({ symbol: String(r.symbol ?? ""), price: Number(r.markPrice) })).filter((r) => r.symbol && Number.isFinite(r.price) && r.price > 0);
  }
  /** The primary account id (0 when SoDEX has never seen a deposit from the wallet). */
  async accountId(address) {
    const a = address.toLowerCase();
    try {
      const s = await this.get(`/api/v1/user/${a}/subaccounts`);
      if (s && typeof s.primaryAccountID === "number" && s.primaryAccountID > 0) return s.primaryAccountID;
    } catch (e) {
      if (!(e instanceof SodexApiError && /user not found/i.test(e.message))) throw e;
    }
    const st = await this.perpsState(a);
    return st && typeof st.aid === "number" && st.aid > 0 ? st.aid : 0;
  }
  async perpsState(address) {
    return this.get(`/api/v1/perps/accounts/${address.toLowerCase()}/state`);
  }
  /** The follower's account as the copier needs it. */
  async follower(address, now = Date.now()) {
    return followerFromState(await this.perpsState(address), now);
  }
  /** Leader positions on SoDEX, symbol -> signed size, plus equity. */
  async leaderPositions(address) {
    const st = await this.perpsState(address);
    const positions = {};
    const marks = {};
    for (const p of st?.P ?? []) {
      const sz = Number(p.sz);
      if (p.s && Number.isFinite(sz) && sz !== 0) positions[p.s] = sz;
    }
    const av = Number(st?.av);
    return { positions, equity: Number.isFinite(av) ? av : null, marks };
  }
  /** The account's API keys on perps (names are public). */
  async apiKeys(address, engine = "perps") {
    const rows2 = await this.get(`/api/v1/${engine}/accounts/${address.toLowerCase()}/api-keys`);
    return Array.isArray(rows2) ? rows2 : rows2?.apiKeys ?? [];
  }
  /** Whether `keyAddress` is registered under `name` and not expired. */
  async keyRegistered(owner, name, keyAddress, now = Date.now()) {
    const rows2 = await this.apiKeys(owner, "perps");
    const row = rows2.find((r) => r.name === name);
    if (!row || row.publicKey.toLowerCase() !== keyAddress.toLowerCase()) return { ok: false, expiresAt: null };
    if (row.expiresAt && row.expiresAt <= now) return { ok: false, expiresAt: row.expiresAt };
    return { ok: true, expiresAt: row.expiresAt || null };
  }
  /** The perps builder-fee ceiling the account approved for `builderId` (null: none). */
  async builderApproval(owner, builderId) {
    const data = await this.get(`/api/v1/user/${owner.toLowerCase()}/builders`);
    return approvedBuilderRates(data, builderId).perps;
  }
};
function followerFromState(st, now = Date.now()) {
  const positions = {};
  for (const p of st?.P ?? []) {
    const size = Number(p.sz);
    if (!p.s || !Number.isFinite(size) || size === 0) continue;
    positions[p.s] = {
      size,
      entry: Number(p.ep) || 0,
      leverage: typeof p.l === "number" ? p.l : 1,
      marginMode: p.m === "ISOLATED" ? "isolated" : "cross"
    };
  }
  const equity = Number(st?.av);
  const available = Number(st?.am);
  return {
    accountId: typeof st?.aid === "number" ? st.aid : 0,
    equity: Number.isFinite(equity) ? equity : 0,
    available: Number.isFinite(available) ? available : 0,
    positions,
    at: now
  };
}
var HL_INFO_URL = "https://api.hyperliquid.xyz/info";
var HL_WS_URL = "wss://api.hyperliquid.xyz/ws";
var HyperliquidClient = class {
  constructor(fetch2, url = HL_INFO_URL) {
    this.fetch = fetch2;
    this.url = url;
  }
  fetch;
  url;
  async post(body, attempts = 3) {
    let last;
    for (let i = 1; i <= attempts; i++) {
      const ctl = abortController();
      const timer = timers.after(1e4, () => ctl.abort());
      try {
        const res = await this.fetch(this.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
        const text = await res.text();
        if (!res.ok) throw new SodexApiError(res.status, `Hyperliquid answered HTTP ${res.status}`, res.status, this.url);
        return JSON.parse(text);
      } catch (e) {
        last = e;
        if (i >= attempts || !isTransientFailure(e)) throw e;
        await sleep(300 * 2 ** (i - 1));
      } finally {
        timers.cancel(timer);
      }
    }
    throw last;
  }
  /** Perp positions (coin -> signed size) and account value. */
  async leaderPositions(address) {
    const st = await this.post({ type: "clearinghouseState", user: address.toLowerCase() });
    const positions = {};
    const marks = {};
    for (const ap of st?.assetPositions ?? []) {
      const p = ap.position;
      const sz = Number(p?.szi);
      if (p?.coin && Number.isFinite(sz) && sz !== 0) {
        positions[p.coin] = sz;
        const pv = Number(p.positionValue);
        if (Number.isFinite(pv) && pv > 0) marks[p.coin] = pv / Math.abs(sz);
      }
    }
    const av = Number(st?.marginSummary?.accountValue);
    return { positions, equity: Number.isFinite(av) ? av : null, marks };
  }
};

// packages/copy-engine/src/socket.ts
var LiveSocket = class {
  constructor(o) {
    this.o = o;
  }
  o;
  ws = null;
  running = false;
  attempt = 0;
  lastMessageAt = 0;
  lastPingAt = 0;
  tick = null;
  retry = null;
  /** When the socket last came up (null while down). */
  upSince = null;
  start() {
    if (this.running) return;
    this.running = true;
    this.connect();
    this.tick = timers.every(1e4, () => this.check());
  }
  stop() {
    this.running = false;
    timers.cancel(this.tick);
    timers.cancel(this.retry);
    this.tick = this.retry = null;
    this.drop();
  }
  get up() {
    return this.upSince !== null;
  }
  send(msg) {
    const ws = this.ws;
    if (ws && ws.readyState === WS_OPEN) ws.send(JSON.stringify(msg));
  }
  /** Re-run `subscribe` on the live socket (the subscription set changed). */
  resubscribe() {
    if (this.ws && this.ws.readyState === WS_OPEN) this.o.subscribe((m) => this.send(m), false);
  }
  connect() {
    if (!this.running || this.ws) return;
    let ws;
    try {
      ws = this.o.factory(this.o.url);
    } catch (e) {
      this.o.log?.warn(`${this.o.name ?? "socket"}: could not open`, { error: String(e) });
      this.schedule();
      return;
    }
    this.ws = ws;
    this.lastMessageAt = Date.now();
    ws.onopen = () => {
      this.attempt = 0;
      this.upSince = Date.now();
      this.o.onState?.(true);
      this.lastPingAt = Date.now();
      this.o.subscribe((m) => this.send(m), true);
    };
    ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now();
      const raw = typeof ev.data === "string" ? ev.data : String(ev.data);
      if (!raw || raw === "pong") return;
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        this.o.onMessage(msg);
      } catch (e) {
        this.o.log?.error(`${this.o.name ?? "socket"}: handler failed`, { error: String(e) });
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.upSince !== null;
      this.upSince = null;
      if (was) this.o.onState?.(false);
      this.schedule();
    };
    ws.onerror = () => {
    };
  }
  drop() {
    const ws = this.ws;
    this.ws = null;
    if (this.upSince !== null) this.o.onState?.(false);
    this.upSince = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close();
      } catch {
      }
    }
  }
  schedule() {
    if (!this.running) return;
    timers.cancel(this.retry);
    const base2 = Math.min(3e4, 1e3 * 2 ** this.attempt++);
    const delay = base2 / 2 + Math.random() * (base2 / 2);
    this.retry = timers.after(delay, () => {
      this.retry = null;
      this.connect();
    });
  }
  check() {
    if (!this.running) return;
    const now = Date.now();
    if (this.ws && now - this.lastMessageAt > (this.o.staleMs ?? 9e4)) {
      this.o.log?.warn(`${this.o.name ?? "socket"}: silent, replacing`, { silentMs: now - this.lastMessageAt });
      this.drop();
      this.schedule();
      return;
    }
    if (this.ws && this.ws.readyState === WS_OPEN && now - this.lastPingAt >= (this.o.pingMs ?? 3e4)) {
      this.lastPingAt = now;
      try {
        this.ws.send(this.o.ping);
      } catch {
      }
    }
  }
};

// packages/copy-engine/src/feeds.ts
var COALESCE_MS = 150;
var key = (l) => `${l.venue}:${l.address.toLowerCase()}`;
var LeaderBook = class {
  pos = /* @__PURE__ */ new Map();
  eq = /* @__PURE__ */ new Map();
  seededAt = /* @__PURE__ */ new Map();
  seeded(l) {
    return this.seededAt.has(key(l));
  }
  seedTime(l) {
    return this.seededAt.get(key(l)) ?? null;
  }
  positions(l) {
    return Object.fromEntries(this.pos.get(key(l)) ?? []);
  }
  position(l, symbol2) {
    return this.pos.get(key(l))?.get(symbol2) ?? 0;
  }
  equity(l) {
    return this.eq.get(key(l)) ?? null;
  }
  forget(l) {
    this.pos.delete(key(l));
    this.eq.delete(key(l));
    this.seededAt.delete(key(l));
  }
  /** A position change by `delta` from the stream. Null while the leader is not seeded. */
  applyDelta(l, symbol2, delta, price2, time2, id) {
    if (!this.seeded(l) || !Number.isFinite(delta) || delta === 0) return null;
    const m = this.map(l);
    const before = m.get(symbol2) ?? 0;
    let after = before + delta;
    if (Math.abs(after) < 1e-12 * Math.max(1, Math.abs(before))) after = 0;
    if (after === 0) m.delete(symbol2);
    else m.set(symbol2, after);
    return { leader: { venue: l.venue, address: l.address.toLowerCase() }, symbol: symbol2, before, after, price: price2, time: time2, id, source: "stream" };
  }
  /** A position change to `after` (a source that knows the total). */
  applyTotal(l, symbol2, before, after, price2, time2, id) {
    if (!this.seeded(l)) return null;
    const m = this.map(l);
    const b = before ?? m.get(symbol2) ?? 0;
    if (after === 0) m.delete(symbol2);
    else m.set(symbol2, after);
    if (b === after) return null;
    return { leader: { venue: l.venue, address: l.address.toLowerCase() }, symbol: symbol2, before: b, after, price: price2, time: time2, id, source: "stream" };
  }
  /**
   * The REST truth. The first call seeds the leader (no events: whatever is
   * open now is "pre-existing"); later calls emit a 'reconcile' event per
   * market that differs.
   */
  resync(l, positions, equity, marks, now, priceOf) {
    const k = key(l);
    if (equity !== null) this.eq.set(k, { value: equity, at: now });
    if (!this.seededAt.has(k)) {
      this.seededAt.set(k, now);
      this.pos.set(k, new Map(Object.entries(positions).filter(([, v]) => v !== 0)));
      return [];
    }
    const m = this.map(l);
    const out = [];
    const symbols = /* @__PURE__ */ new Set([...m.keys(), ...Object.keys(positions)]);
    for (const s of symbols) {
      const before = m.get(s) ?? 0;
      const after = positions[s] ?? 0;
      const tol = 1e-9 * Math.max(1, Math.abs(before), Math.abs(after));
      if (Math.abs(before - after) <= tol) continue;
      if (after === 0) m.delete(s);
      else m.set(s, after);
      const price2 = marks[s] ?? priceOf(s) ?? 0;
      out.push({ leader: { venue: l.venue, address: l.address.toLowerCase() }, symbol: s, before, after, price: price2, time: now, id: `rc:${s}:${now}`, source: "reconcile" });
    }
    return out;
  }
  map(l) {
    const k = key(l);
    let m = this.pos.get(k);
    if (!m) this.pos.set(k, m = /* @__PURE__ */ new Map());
    return m;
  }
};
var Coalescer = class {
  constructor(flush) {
    this.flush = flush;
  }
  flush;
  pending = /* @__PURE__ */ new Map();
  add(l, symbol2, delta, price2, time2, id) {
    const k = `${key(l)}|${symbol2}`;
    let p = this.pending.get(k);
    if (!p) {
      p = { l, symbol: symbol2, delta: 0, notional: 0, qty: 0, time: time2, ids: [], timer: null };
      this.pending.set(k, p);
      const entry = p;
      p.timer = timers.after(COALESCE_MS, () => {
        this.pending.delete(k);
        if (entry.delta !== 0) this.flush(entry.l, entry.symbol, entry.delta, entry.notional / entry.qty, entry.time, entry.ids[0]);
      });
    }
    p.delta += delta;
    p.notional += Math.abs(delta) * price2;
    p.qty += Math.abs(delta);
    p.time = Math.max(p.time, time2);
    p.ids.push(id);
  }
  stop() {
    for (const p of this.pending.values()) timers.cancel(p.timer);
    this.pending.clear();
  }
};
var Seen = class {
  constructor(cap = 5e4) {
    this.cap = cap;
  }
  cap;
  set = /* @__PURE__ */ new Set();
  add(id) {
    if (this.set.has(id)) return false;
    this.set.add(id);
    if (this.set.size > this.cap) {
      let n = Math.floor(this.cap / 10);
      for (const k of this.set) {
        this.set.delete(k);
        if (--n <= 0) break;
      }
    }
    return true;
  }
};
var SodexFeed = class {
  constructor(o) {
    this.o = o;
    this.coalesce = new Coalescer((l, symbol2, delta, vwap, time2, id) => {
      const e = this.o.book.applyDelta(l, symbol2, delta, vwap, time2, id);
      if (e) this.o.sink.leader(e);
    });
    const origin = o.wsOrigin ?? GATEWAY_WS_ORIGIN[o.network];
    this.socket = new LiveSocket({
      url: `${origin}/ws/perps`,
      factory: o.factory,
      ping: '{"op":"ping"}',
      name: "sodex-perps",
      log: o.log,
      subscribe: (send, fresh) => this.subscribeAll(send, fresh),
      onMessage: (m) => this.handle(m),
      onState: (up) => o.sink.state?.("sodex", up)
    });
  }
  o;
  socket;
  leadersById = /* @__PURE__ */ new Map();
  followers = /* @__PURE__ */ new Set();
  seen = new Seen();
  coalesce;
  subscribed = /* @__PURE__ */ new Set();
  start() {
    this.socket.start();
  }
  stop() {
    this.socket.stop();
    this.coalesce.stop();
  }
  get up() {
    return this.socket.up;
  }
  /** Leaders to follow, by SoDEX account id. */
  setLeaders(list) {
    this.leadersById = new Map(list.filter((x) => x.accountId > 0).map((x) => [x.accountId, x.ref]));
  }
  /** Follower accounts whose fills to report. */
  setFollowers(accountIds) {
    this.followers = new Set(accountIds.filter((x) => x > 0));
  }
  /** The market list grew: subscribe the new ones. */
  refreshSymbols() {
    this.socket.resubscribe();
  }
  subscribeAll(send, fresh) {
    if (fresh) {
      this.subscribed.clear();
      send({ op: "subscribe", id: 1, params: { channel: "allMarkPrice" } });
    }
    const all = this.o.symbols().filter((s) => !this.subscribed.has(s));
    for (let i = 0; i < all.length; i += 40) {
      const chunk = all.slice(i, i + 40);
      send({ op: "subscribe", id: 100 + i, params: { channel: "trade", symbols: chunk } });
      for (const s of chunk) this.subscribed.add(s);
    }
  }
  handle(m) {
    const msg = m;
    if (msg.channel === "allMarkPrice" && Array.isArray(msg.data)) {
      for (const r of msg.data) {
        const p = Number(r.p);
        if (r.s && Number.isFinite(p)) this.o.sink.mark?.(r.s, p, r.E ?? Date.now());
      }
      return;
    }
    if (msg.channel !== "trade" || !Array.isArray(msg.data)) return;
    for (const t of msg.data) {
      if (!t.s || typeof t.t !== "number") continue;
      const id = `sodex:${t.s}:${t.t}`;
      if (!this.seen.add(id)) continue;
      const price2 = Number(t.p);
      const qty2 = Number(t.q);
      const time2 = t.T ?? Date.now();
      if (!(price2 > 0) || !(qty2 > 0)) continue;
      const buyer = typeof t.bi === "number" ? t.bi : -1;
      const seller = typeof t.si === "number" ? t.si : -1;
      if (buyer === seller) continue;
      const takerBuy = t.S === "BUY";
      for (const [acct, side] of [[buyer, "buy"], [seller, "sell"]]) {
        const l = this.leadersById.get(acct);
        if (l) {
          const seed = this.o.book.seedTime(l);
          if (seed !== null && time2 >= seed) this.coalesce.add(l, t.s, side === "buy" ? qty2 : -qty2, price2, time2, id);
        }
        if (this.followers.has(acct)) {
          this.o.sink.follower?.({
            id,
            accountId: acct,
            symbol: t.s,
            side,
            price: price2,
            qty: qty2,
            taker: side === "buy" ? takerBuy : !takerBuy,
            time: time2,
            clOrdID: null,
            fee: null
          });
        }
      }
    }
  }
};
var HL_USER_LIMIT = 10;
var HyperliquidFeed = class {
  constructor(o) {
    this.o = o;
    this.coalesce = new Coalescer((l, symbol2, delta, vwap, time2, id) => {
      const e = this.o.book.applyDelta(l, symbol2, delta, vwap, time2, id);
      if (e) this.o.sink.leader(e);
    });
    this.socket = new LiveSocket({
      url: o.url ?? HL_WS_URL,
      factory: o.factory,
      ping: '{"method":"ping"}',
      name: `hyperliquid-${o.mode}`,
      log: o.log,
      subscribe: (send, fresh) => this.subscribeAll(send, fresh),
      onMessage: (m) => this.handle(m),
      onState: (up) => o.sink.state?.("hyperliquid", up)
    });
  }
  o;
  socket;
  leaders = /* @__PURE__ */ new Map();
  seen = new Seen();
  coalesce;
  subscribedUsers = /* @__PURE__ */ new Set();
  subscribedCoins = /* @__PURE__ */ new Set();
  start() {
    this.socket.start();
  }
  stop() {
    this.socket.stop();
    this.coalesce.stop();
  }
  get up() {
    return this.socket.up;
  }
  setLeaders(list) {
    const next = new Map(list.filter((l) => l.venue === "hyperliquid").map((l) => [l.address.toLowerCase(), l]));
    if (this.o.mode === "user") {
      for (const u of this.subscribedUsers) {
        if (!next.has(u)) {
          this.socket.send({ method: "unsubscribe", subscription: { type: "userFills", user: u } });
          this.subscribedUsers.delete(u);
        }
      }
    }
    this.leaders = next;
    this.socket.resubscribe();
  }
  refreshCoins() {
    this.socket.resubscribe();
  }
  subscribeAll(send, fresh) {
    if (fresh) {
      this.subscribedUsers.clear();
      this.subscribedCoins.clear();
    }
    if (this.o.mode === "user") {
      let n = this.subscribedUsers.size;
      for (const u of this.leaders.keys()) {
        if (this.subscribedUsers.has(u)) continue;
        if (n >= HL_USER_LIMIT) {
          this.o.log?.warn("hyperliquid: more leaders than one IP may follow per user; the rest rely on reconciliation", { limit: HL_USER_LIMIT });
          break;
        }
        send({ method: "subscribe", subscription: { type: "userFills", user: u } });
        this.subscribedUsers.add(u);
        n++;
      }
      return;
    }
    for (const c of this.o.coins?.() ?? []) {
      if (this.subscribedCoins.has(c)) continue;
      send({ method: "subscribe", subscription: { type: "trades", coin: c } });
      this.subscribedCoins.add(c);
    }
  }
  handle(m) {
    const msg = m;
    if (msg.channel === "userFills") {
      const d = msg.data;
      if (!d || d.isSnapshot || !d.user) return;
      const l = this.leaders.get(d.user.toLowerCase());
      if (!l) return;
      const seed = this.o.book.seedTime(l);
      const byOrder = /* @__PURE__ */ new Map();
      for (const f of d.fills ?? []) {
        const coin = String(f.coin ?? "");
        const sz = Number(f.sz);
        const px = Number(f.px);
        const start = Number(f.startPosition);
        const time2 = Number(f.time);
        const id = `hl:${String(f.tid ?? f.hash ?? `${coin}:${time2}`)}`;
        if (!coin || !(sz > 0) || !(px > 0) || !Number.isFinite(start) || !this.seen.add(id)) continue;
        if (seed !== null && time2 < seed) continue;
        if (coin.startsWith("@") || coin.includes("/")) continue;
        const signed = f.side === "B" ? sz : -sz;
        const k = `${coin}|${String(f.oid ?? time2)}`;
        const g = byOrder.get(k);
        if (!g) byOrder.set(k, { coin, before: start, after: start + signed, notional: sz * px, qty: sz, time: time2, id });
        else {
          g.after += signed;
          g.notional += sz * px;
          g.qty += sz;
          g.time = Math.max(g.time, time2);
        }
      }
      for (const g of byOrder.values()) {
        const after = Math.abs(g.after) < 1e-12 ? 0 : g.after;
        const e = this.o.book.applyTotal(l, g.coin, null, after, g.notional / g.qty, g.time, g.id);
        if (e) this.o.sink.leader(e);
      }
      return;
    }
    if (msg.channel === "trades" && Array.isArray(msg.data)) {
      for (const t of msg.data) {
        if (!t.coin || !Array.isArray(t.users)) continue;
        const id = `hl:${t.tid ?? `${t.coin}:${t.time}`}`;
        if (!this.seen.add(id)) continue;
        const px = Number(t.px);
        const sz = Number(t.sz);
        const time2 = t.time ?? Date.now();
        if (!(px > 0) || !(sz > 0)) continue;
        const [buyer, seller] = [t.users[0]?.toLowerCase(), t.users[1]?.toLowerCase()];
        if (buyer === seller) continue;
        for (const [addr, signed] of [[buyer, sz], [seller, -sz]]) {
          const l = addr ? this.leaders.get(addr) : void 0;
          if (!l) continue;
          const seed = this.o.book.seedTime(l);
          if (seed !== null && time2 >= seed) this.coalesce.add(l, t.coin, signed, px, time2, id);
        }
      }
    }
  }
};

// packages/copy-engine/src/orders.ts
function intentsAction(accountId, market, intents, builder) {
  return perpsActions.newOrder(
    accountId,
    market.id,
    intents.map((i) => ({
      clOrdID: i.clOrdID,
      modifier: OrderModifier.NORMAL,
      side: i.side === "buy" ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.LIMIT,
      timeInForce: TimeInForce.IOC,
      price: i.limitPrice,
      quantity: i.quantity,
      reduceOnly: i.reduceOnly
    })),
    builder ?? void 0
  );
}
function stopAction(accountId, market, s, builder) {
  return perpsActions.newOrder(
    accountId,
    market.id,
    [
      {
        clOrdID: s.clOrdID,
        modifier: OrderModifier.STOP,
        side: s.side === "buy" ? OrderSide.BUY : OrderSide.SELL,
        type: OrderType.MARKET,
        timeInForce: TimeInForce.IOC,
        quantity: s.quantity,
        stopPrice: s.triggerPrice,
        stopType: s.kind === "take-profit" ? StopType.TAKE_PROFIT : StopType.STOP_LOSS,
        triggerType: TriggerType.MARK_PRICE,
        reduceOnly: true
      }
    ],
    builder ?? void 0
  );
}
var cancelAction = (accountId, market, clOrdID) => perpsActions.cancelOrder(accountId, [{ symbolID: market.id, clOrdID }]);
var leverageAction = (accountId, market, leverage, margin) => perpsActions.updateLeverage(accountId, market.id, Math.max(1, Math.min(leverage, market.maxLeverage)), margin === "isolated" ? MarginMode.ISOLATED : MarginMode.CROSS);
var describe = (e) => e instanceof SodexApiError ? `${e.message}${e.hint ? ` (${e.hint})` : ""}` : e instanceof Error ? e.message : String(e);
var KeySink = class {
  constructor(client, key2, nonces, chainId) {
    this.client = client;
    this.key = key2;
    this.nonces = nonces;
    this.chainId = chainId;
  }
  client;
  key;
  nonces;
  chainId;
  paper = false;
  async signAndSend(action2) {
    const key2 = this.key();
    if (!key2) throw new SodexApiError(401, "no copy key is available", 401, "");
    const req = await signAndBuildWithNonceManager(action2, key2, { chainId: this.chainId, nonces: this.nonces, base: "" });
    return this.client.send(req);
  }
  async place(accountId, market, intents, builder) {
    if (!intents.length) return [];
    try {
      const data = await this.signAndSend(intentsAction(accountId, market, intents, builder));
      const rows2 = Array.isArray(data) ? data : unwrapList(data, "orders");
      const failed = new Set(failedOrders(rows2).map((r) => r.clOrdID));
      return intents.map((i) => {
        const row = rows2.find((r) => r.clOrdID === i.clOrdID);
        const bad = failed.has(i.clOrdID);
        return {
          clOrdID: i.clOrdID,
          ok: !bad,
          orderId: row?.orderID !== void 0 ? String(row.orderID) : null,
          error: bad ? row?.error || `code ${row?.code}` : null,
          outcomeUnknown: false
        };
      });
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return intents.map((i) => ({ clOrdID: i.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: unknown }));
    }
  }
  async setLeverage(accountId, market, leverage, margin) {
    await this.signAndSend(leverageAction(accountId, market, leverage, margin));
  }
  async placeStop(accountId, market, stop, builder) {
    try {
      const data = await this.signAndSend(stopAction(accountId, market, stop, builder));
      const rows2 = Array.isArray(data) ? data : unwrapList(data, "orders");
      const bad = failedOrders(rows2)[0];
      return { clOrdID: stop.clOrdID, ok: !bad, orderId: null, error: bad ? bad.error || `code ${bad.code}` : null, outcomeUnknown: false };
    } catch (e) {
      return { clOrdID: stop.clOrdID, ok: false, orderId: null, error: describe(e), outcomeUnknown: e instanceof OutcomeUnknownError };
    }
  }
  async cancel(accountId, market, clOrdID) {
    try {
      await this.signAndSend(cancelAction(accountId, market, clOrdID));
    } catch (e) {
      if (e instanceof SodexApiError && /not found|unknown order|does not exist|already/i.test(e.message)) return;
      throw e;
    }
  }
};
var PaperSink = class {
  paper = true;
  n = 0;
  async place(_accountId, _market, intents, _builder, reference) {
    return intents.map((i) => {
      const px = i.side === "buy" ? reference * 1.0001 : reference * 0.9999;
      return { clOrdID: i.clOrdID, ok: true, orderId: `paper-${++this.n}`, error: null, outcomeUnknown: false, paperFill: { qty: Number(i.quantity), price: px } };
    });
  }
  async setLeverage() {
  }
  async placeStop(_a, _m, stop) {
    return { clOrdID: stop.clOrdID, ok: true, orderId: null, error: null, outcomeUnknown: false };
  }
  async cancel() {
  }
};

// packages/copy-engine/src/runtime.ts
var RECONCILE_MS = 6e4;
var FOLLOWER_REFRESH_MS = 3e4;
var GUARD_MS = 2e3;
var READY_CHECK_MS = 10 * 6e4;
var MARKETS_REFRESH_MS = 10 * 6e4;
var PENDING_MS = 3e4;
var QUIET_SKIPS = /* @__PURE__ */ new Set(["duplicate", "at-target", "no-follower-position", "spot-not-copied"]);
var lk = (l) => `${l.venue}:${l.address.toLowerCase()}`;
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
var CopyRuntime = class {
  constructor(host2) {
    this.host = host2;
  }
  host;
  markets = new MarketBook();
  leaders = new LeaderBook();
  subs = /* @__PURE__ */ new Map();
  states = /* @__PURE__ */ new Map();
  followers = /* @__PURE__ */ new Map();
  followerAccounts = /* @__PURE__ */ new Map();
  sodexIds = /* @__PURE__ */ new Map();
  queues = /* @__PURE__ */ new Map();
  pending = [];
  /** `${subId}|${symbol}` -> the last order that opened or added, so a fill the stream missed is still adopted. */
  recentGrow = /* @__PURE__ */ new Map();
  leverageSet = /* @__PURE__ */ new Map();
  refreshTimers = /* @__PURE__ */ new Map();
  stopTimers = /* @__PURE__ */ new Map();
  timers = [];
  sodexFeed = null;
  hlFeed = null;
  hlCoins = [];
  running = false;
  feedUp = { sodex: false, hyperliquid: false };
  dirty = /* @__PURE__ */ new Set();
  /* ------------------------------------------------------------ lifecycle ----- */
  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadMarkets();
    for (const s of await this.host.store.subscriptions()) {
      this.subs.set(s.id, s);
      this.states.set(s.id, await this.host.store.state(s.id) ?? freshState(s.id, s.settings.allocationUsd));
    }
    this.sodexFeed = new SodexFeed({
      network: this.host.network,
      factory: this.host.factory,
      book: this.leaders,
      log: this.host.log,
      symbols: () => this.markets.all().map((m) => m.name),
      sink: {
        leader: (e) => this.onLeaderEvent(e),
        follower: (f) => this.onFollowerFill(f),
        mark: (s, p, at) => this.markets.setMark(s, p, at),
        state: (_f, up) => {
          this.feedUp.sodex = up;
          if (up) void this.reconcileAll();
        }
      }
    });
    this.sodexFeed.start();
    await this.syncFeeds();
    for (const s of this.subs.values()) if (this.live(s)) void this.checkReady(s);
    this.timers.push(
      timers.every(RECONCILE_MS, () => void this.reconcileAll()),
      timers.every(FOLLOWER_REFRESH_MS, () => void this.refreshAllFollowers()),
      timers.every(GUARD_MS, () => void this.runGuards()),
      timers.every(READY_CHECK_MS, () => {
        for (const s of this.subs.values()) if (this.live(s)) void this.checkReady(s);
      }),
      timers.every(MARKETS_REFRESH_MS, () => void this.loadMarkets().then(() => this.sodexFeed?.refreshSymbols())),
      timers.every(5e3, () => void this.flush())
    );
    void this.reconcileAll();
    void this.refreshAllFollowers();
  }
  async stop() {
    this.running = false;
    for (const t of this.timers) timers.cancel(t);
    this.timers = [];
    for (const t of this.refreshTimers.values()) timers.cancel(t);
    for (const t of this.stopTimers.values()) timers.cancel(t);
    this.sodexFeed?.stop();
    this.hlFeed?.stop();
    await Promise.allSettled([...this.queues.values()]);
    await this.flush();
  }
  /* ------------------------------------------------------- subscriptions ----- */
  get(id) {
    return this.subs.get(id) ?? null;
  }
  list(owner) {
    return [...this.subs.values()].filter((s) => !owner || s.owner === owner.toLowerCase());
  }
  /**
   * Start a subscription. The leader is read now: positions it already holds
   * are joined (copyExisting) or left alone until it is flat on them.
   */
  async add(sub) {
    const s = { ...sub, owner: sub.owner.toLowerCase() };
    this.subs.set(s.id, s);
    const st = freshState(s.id, s.settings.allocationUsd);
    this.states.set(s.id, st);
    await this.host.store.saveSubscription(s);
    await this.syncFeeds();
    await this.seedLeader(s.settings.leader);
    const positions = this.leaders.positions(s.settings.leader);
    st.leaderPos = { ...positions };
    st.leaderEquity = this.leaders.equity(s.settings.leader)?.value ?? null;
    st.leaderEquityAt = this.leaders.equity(s.settings.leader)?.at ?? null;
    const now = Date.now();
    if (!s.settings.copyExisting) {
      for (const sym of Object.keys(positions)) st.detached[sym] = "pre-existing";
    }
    await this.host.store.saveState(st);
    await this.activity(s, { kind: "status", reason: s.status, detail: s.settings.paper ? "Paper copy started." : "Copying started." });
    if (this.live(s)) await this.checkReady(s);
    if (s.settings.copyExisting) {
      for (const [sym, size] of Object.entries(positions)) {
        const price2 = this.priceFor(s.settings.leader.venue, sym) ?? 0;
        this.dispatch(s, { leader: s.settings.leader, symbol: sym, before: 0, after: size, price: price2, time: now, id: `join:${sym}:${now}`, source: "reconcile" });
      }
    }
    void this.refreshFollower(s.owner);
    return s;
  }
  /** New rules for a running subscription (the leader cannot change: that is a new subscription). */
  async update(id, patch) {
    const s = this.need(id);
    if (patch.settings && lk(patch.settings.leader) !== lk(s.settings.leader)) throw new Error("The trader of a copy cannot change; start a new copy instead.");
    if (patch.settings && patch.settings.paper !== s.settings.paper) throw new Error("A copy cannot switch between paper and live; start a new copy instead.");
    if (patch.settings && (patch.settings.direction ?? "copy") !== (s.settings.direction ?? "copy")) {
      throw new Error("A copy cannot switch between copying and counter-trading; start a new copy instead.");
    }
    const next = { ...s, ...patch, updatedAt: Date.now() };
    this.subs.set(id, next);
    await this.host.store.saveSubscription(next);
    await this.activity(next, { kind: "status", reason: "updated", detail: "Copy rules changed." });
    return next;
  }
  async setStatus(id, status, reason) {
    const s = this.need(id);
    if (s.status === "stopped" && status !== "stopped") throw new Error("A stopped copy cannot be restarted; start a new copy.");
    if (s.status === status && s.statusReason === reason) return s;
    const next = { ...s, status, statusReason: reason, updatedAt: Date.now() };
    this.subs.set(id, next);
    await this.host.store.saveSubscription(next);
    await this.activity(next, { kind: "status", reason: status, detail: reason });
    if (status === "active") void this.refreshFollower(next.owner);
    if (status === "stopped") {
      this.cancelAllStops(next);
      await this.syncFeeds();
    }
    this.host.onChange?.(id);
    return next;
  }
  pause = (id) => this.setStatus(id, "paused", "Paused by you.");
  async resume(id) {
    const s = this.need(id);
    if (s.status === "halted" || s.status === "blocked") {
      if (s.status === "halted") {
        const st = this.stateOf(s);
        st.peakEquity = copyEquity(s.settings, st, (m) => this.markets.mark(m));
        this.dirty.add(s.id);
      }
    }
    const next = await this.setStatus(id, "active", null);
    if (this.live(next)) await this.checkReady(next);
    return this.need(id);
  }
  /** Stop a copy for good. With `close`, its positions are closed at the market (reduce-only). */
  async stopCopy(id, o) {
    const s = this.need(id);
    if (o.close) await this.closeAll(s, "stop-all");
    return this.setStatus(id, "stopped", o.close ? "Stopped by you; positions closed." : "Stopped by you; positions kept.");
  }
  /** The kill switch: every copy of `owner` stops. */
  async stopAll(owner, o) {
    const out = [];
    for (const s of this.list(owner)) if (s.status !== "stopped") out.push(await this.stopCopy(s.id, o));
    return out;
  }
  view(id) {
    const s = this.subs.get(id);
    if (!s) return null;
    const st = this.stateOf(s);
    const markOf = (m) => this.markets.mark(m, 10 * 6e4);
    const equity = copyEquity(s.settings, st, markOf);
    const policy = this.host.policyFor(s);
    const positions = Object.entries(st.owned).map(([sym, p]) => {
      const mark = markOf(sym);
      const m = this.markets.get(sym);
      const lev = m ? effectiveLeverage(s.settings.maxLeverage, policy, m.maxLeverage) : s.settings.maxLeverage;
      return {
        symbol: sym,
        size: p.size,
        entry: p.entry,
        mark,
        notionalUsd: Math.abs(p.size) * (mark ?? p.entry),
        unrealizedPnl: mark === null ? 0 : p.size * (mark - p.entry),
        stopLoss: guardTrigger("stop-loss", p, s.settings, lev),
        takeProfit: guardTrigger("take-profit", p, s.settings, lev)
      };
    });
    const gross = grossNotional(st, markOf);
    const peak = Math.max(st.peakEquity, equity);
    return {
      subscription: s,
      equity,
      pnl: equity - s.settings.allocationUsd,
      pnlPct: s.settings.allocationUsd > 0 ? (equity - s.settings.allocationUsd) / s.settings.allocationUsd : 0,
      realizedPnl: st.realizedPnl,
      unrealizedPnl: unrealized(st, markOf),
      fees: st.fees,
      grossNotional: gross,
      leverage: equity > 0 ? gross / equity : 0,
      peakEquity: peak,
      drawdownPct: peak > 0 ? Math.max(0, (peak - equity) / peak) : 0,
      positions,
      leader: { positions: this.leaders.positions(s.settings.leader), equity: this.leaders.equity(s.settings.leader)?.value ?? null },
      orders: st.orders,
      skips: st.skips,
      lastEventAt: st.lastEventAt,
      feeds: { sodex: this.feedUp.sodex, hyperliquid: this.hlFeed ? this.feedUp.hyperliquid : null }
    };
  }
  /* --------------------------------------------------------------- events ----- */
  onLeaderEvent(e) {
    for (const s of shuffle(this.list())) {
      if (lk(s.settings.leader) !== lk(e.leader)) continue;
      if (s.status === "stopped") continue;
      this.dispatch(s, e);
    }
  }
  dispatch(s, e) {
    const market = this.markets.sodexMarketFor(e.leader.venue, e.symbol);
    const mark = market ? this.markets.mark(market.name) : null;
    this.enqueue(s.owner, () => this.process(s.id, e, market, mark));
  }
  enqueue(owner, fn) {
    const prev = this.queues.get(owner) ?? Promise.resolve();
    const next = prev.then(fn).catch((err) => this.host.log.error("copy: a step failed", { owner, error: String(err) }));
    this.queues.set(owner, next);
    void next.finally(() => {
      if (this.queues.get(owner) === next) this.queues.delete(owner);
    });
  }
  async process(subId, e, market, mark) {
    const s = this.subs.get(subId);
    if (!s || s.status === "stopped") return;
    const st = this.stateOf(s);
    const markOf = (sym) => market && sym === market.name && mark !== null ? mark : this.markets.mark(sym);
    const plan = planLeaderEvent({
      sub: s,
      state: st,
      event: e,
      market,
      markOf,
      policy: this.host.policyFor(s),
      heldBy: market ? this.heldBy(s, market.name) : "nobody",
      follower: this.followers.get(s.owner) ?? null
    });
    st.leaderPos[e.symbol] = plan.leaderAfter;
    if (plan.leaderAfter === 0) delete st.leaderPos[e.symbol];
    if (plan.attach) delete st.detached[e.symbol];
    if (plan.detach) st.detached[e.symbol] = plan.detach;
    if (plan.skip !== "duplicate") noteSeen(st, e.id);
    st.lastEventAt = e.time;
    const leader = { symbol: e.symbol, before: e.before ?? 0, after: e.after, price: e.price, time: e.time };
    if (!plan.intents.length) {
      if (plan.skip && plan.skip !== "duplicate") st.skips++;
      if (plan.skip && !QUIET_SKIPS.has(plan.skip)) await this.activity(s, { kind: "skip", reason: plan.skip, symbol: market?.name ?? e.symbol, leader });
      this.dirty.add(s.id);
      return;
    }
    if (s.settings.approval === "confirm" && this.host.confirm) {
      let yes = false;
      try {
        yes = await this.host.confirm(s, plan.intents, e);
      } catch {
        yes = false;
      }
      if (!yes) {
        st.skips++;
        await this.activity(s, { kind: "skip", reason: "declined", symbol: market.name, leader });
        this.dirty.add(s.id);
        return;
      }
    }
    await this.execute(s, market, plan.intents, markOf(market.name) ?? e.price, leader);
    if (plan.skip && !QUIET_SKIPS.has(plan.skip)) await this.activity(s, { kind: "skip", reason: plan.skip, symbol: market.name, leader });
  }
  /** Who holds the follower's position on `symbol` when this copy does not. */
  heldBy(s, symbol2) {
    if (this.stateOf(s).owned[symbol2]) return "nobody";
    for (const o of this.list(s.owner)) {
      if (o.id === s.id || o.status === "stopped") continue;
      if (o.settings.paper !== s.settings.paper) continue;
      if (this.stateOf(o).owned[symbol2]) return "other-copy";
    }
    if (s.settings.paper) return "nobody";
    const f = this.followers.get(s.owner);
    return f?.positions[symbol2] ? "follower" : "nobody";
  }
  async execute(s, market, intents, reference, leader) {
    const st = this.stateOf(s);
    const sink = this.host.sinkFor(s);
    if (!sink) {
      await this.setStatus(s.id, "blocked", "The copy key is not available here.");
      return [];
    }
    const builder = await this.host.builderFor(s).catch(() => null);
    if (!sink.paper && intents.some((i) => !i.reduceOnly)) await this.ensureLeverage(s, market, sink);
    const results = await sink.place(s.accountId, market, intents, builder, reference);
    for (let i = 0; i < intents.length; i++) {
      const it = intents[i];
      const r = results[i] ?? { clOrdID: it.clOrdID, ok: false, orderId: null, error: "no result", outcomeUnknown: false };
      st.orders += r.ok ? 1 : 0;
      await this.activity(s, {
        kind: r.ok ? "order" : "error",
        reason: r.ok ? it.leg : r.outcomeUnknown ? "outcome-unknown" : "rejected",
        detail: r.ok ? it.clampedBy ? `Smaller than the rule asked: ${it.clampedBy}.` : null : r.error,
        symbol: it.symbol,
        side: it.side,
        size: Number(it.quantity),
        price: Number(it.limitPrice),
        notionalUsd: it.notionalUsd,
        reduceOnly: it.reduceOnly,
        clOrdID: it.clOrdID,
        orderId: r.orderId,
        builderFee: builder?.fee ?? 0,
        leader
      });
      if (r.paperFill) {
        const fee = r.paperFill.qty * r.paperFill.price * (market.takerFee + (builder?.fee ?? 0) / 1e5);
        this.fillBooks(s, it.symbol, it.side, r.paperFill.qty, r.paperFill.price, fee, it.reduceOnly);
        await this.activity(s, {
          kind: "fill",
          reason: it.leg,
          symbol: it.symbol,
          side: it.side,
          size: r.paperFill.qty,
          price: r.paperFill.price,
          notionalUsd: r.paperFill.qty * r.paperFill.price,
          reduceOnly: it.reduceOnly,
          clOrdID: it.clOrdID,
          builderFee: builder?.fee ?? 0,
          leader
        });
      } else if (r.ok || r.outcomeUnknown) {
        if (!it.reduceOnly) this.recentGrow.set(`${s.id}|${it.symbol}`, { side: it.side, at: Date.now() });
        this.pending.push({
          subId: s.id,
          symbol: it.symbol,
          side: it.side,
          reduceOnly: it.reduceOnly,
          remaining: Number(it.quantity),
          clOrdID: it.clOrdID,
          until: Date.now() + PENDING_MS,
          builderFee: builder?.fee ?? 0,
          leg: it.leg
        });
      }
    }
    if (!sink.paper) this.scheduleRefresh(s.owner, 1500);
    this.dirty.add(s.id);
    this.host.onChange?.(s.id);
    return results;
  }
  /** Apply a fill to the copy's books; a reduce-only fill never opens the other side. */
  fillBooks(s, symbol2, side, qty2, price2, fee, reduceOnly) {
    const st = this.stateOf(s);
    let q = qty2;
    if (reduceOnly) {
      const held = Math.abs(st.owned[symbol2]?.size ?? 0);
      q = Math.min(q, held);
      if (!(q > 0)) return;
    }
    applyFill(st, symbol2, side, q, price2, fee, Date.now());
    if (st.owned[symbol2]) this.recentGrow.delete(`${s.id}|${symbol2}`);
    this.dirty.add(s.id);
    if (!s.settings.paper) this.scheduleStops(s, symbol2);
  }
  onFollowerFill(f) {
    if (!f.taker) return;
    const now = Date.now();
    this.pending = this.pending.filter((p) => p.until > now && p.remaining > 1e-12);
    let left = f.qty;
    for (const p of this.pending) {
      if (left <= 0) break;
      if (p.symbol !== f.symbol || p.side !== f.side) continue;
      const s = this.subs.get(p.subId);
      if (!s || s.accountId !== f.accountId) continue;
      const q = Math.min(left, p.remaining);
      p.remaining -= q;
      left -= q;
      const m = this.markets.get(p.symbol);
      const fee = q * f.price * ((m?.takerFee ?? 4e-4) + p.builderFee / 1e5);
      this.fillBooks(s, p.symbol, p.side, q, f.price, fee, p.reduceOnly);
      void this.activity(s, {
        kind: "fill",
        reason: p.leg,
        symbol: p.symbol,
        side: p.side,
        size: q,
        price: f.price,
        notionalUsd: q * f.price,
        reduceOnly: p.reduceOnly,
        clOrdID: p.clOrdID,
        builderFee: p.builderFee
      });
      this.host.onChange?.(s.id);
    }
  }
  /* ------------------------------------------------------------- follower ----- */
  scheduleRefresh(owner, ms) {
    if (this.refreshTimers.has(owner)) return;
    this.refreshTimers.set(
      owner,
      timers.after(ms, () => {
        this.refreshTimers.delete(owner);
        void this.refreshFollower(owner);
      })
    );
  }
  async refreshAllFollowers() {
    const owners = new Set(this.list().filter((s) => this.live(s) && s.status !== "stopped").map((s) => s.owner));
    for (const o of owners) await this.refreshFollower(o);
  }
  /** Re-read the follower's account; the copy's positions follow what SoDEX says. */
  async refreshFollower(owner) {
    const subs = this.list(owner).filter((s) => this.live(s) && s.status !== "stopped");
    if (!subs.length) return;
    let snap;
    try {
      snap = await this.host.sodex.follower(owner);
    } catch (e) {
      this.host.log.warn("copy: follower read failed", { owner, error: String(e) });
      return;
    }
    this.followers.set(owner, snap);
    if (snap.accountId) this.followerAccounts.set(snap.accountId, owner);
    this.sodexFeed?.setFollowers([...this.followerAccounts.keys()]);
    const now = Date.now();
    const inFlight = (subId, sym) => this.pending.some((x) => x.subId === subId && x.symbol === sym && x.until > now && x.remaining > 1e-12);
    for (const s of subs) {
      const st = this.stateOf(s);
      for (const [k, g] of this.recentGrow) {
        if (!k.startsWith(`${s.id}|`)) continue;
        const sym = k.slice(s.id.length + 1);
        if (now - g.at > 10 * 6e4) {
          this.recentGrow.delete(k);
          continue;
        }
        const actual = snap.positions[sym];
        if (st.owned[sym] || !actual || inFlight(s.id, sym) || Math.sign(actual.size) !== (g.side === "buy" ? 1 : -1)) continue;
        if (this.list(s.owner).some((o) => o.id !== s.id && this.states.get(o.id)?.owned[sym])) continue;
        st.owned[sym] = { size: actual.size, entry: actual.entry, openedAt: g.at };
        this.recentGrow.delete(k);
        this.scheduleStops(s, sym);
        this.dirty.add(s.id);
      }
      for (const [sym, p] of Object.entries(st.owned)) {
        if (inFlight(s.id, sym)) continue;
        const actual = snap.positions[sym];
        const mark = this.markets.mark(sym) ?? p.entry;
        if (!actual || Math.sign(actual.size) !== Math.sign(p.size)) {
          st.realizedPnl += p.size * (mark - p.entry);
          delete st.owned[sym];
          this.recentGrow.delete(`${s.id}|${sym}`);
          const why = this.closedWhy(s, p, mark, sym);
          for (const lsym of this.leaderSymbolsFor(s, sym)) if (st.leaderPos[lsym]) st.detached[lsym] = why;
          this.cancelStops(s, sym);
          await this.activity(s, {
            kind: "status",
            reason: why === "own-position" ? "closed-outside" : why,
            symbol: sym,
            detail: why === "own-position" ? "This copied position was closed outside the copier (by you, or by SoDEX). It resumes when the leader is flat." : `Your ${why} closed this copied position.`
          });
          this.dirty.add(s.id);
        } else if (Math.abs(actual.size - p.size) > 1e-12 * Math.max(1, Math.abs(p.size))) {
          st.owned[sym] = { size: actual.size, entry: actual.entry || p.entry, openedAt: p.openedAt };
          this.scheduleStops(s, sym);
          this.dirty.add(s.id);
        }
      }
    }
  }
  closedWhy(s, p, mark, sym) {
    const m = this.markets.get(sym);
    const lev = m ? effectiveLeverage(s.settings.maxLeverage, this.host.policyFor(s), m.maxLeverage) : s.settings.maxLeverage;
    const sl = guardTrigger("stop-loss", p, s.settings, lev);
    const tp = guardTrigger("take-profit", p, s.settings, lev);
    if (sl !== null && (p.size > 0 ? mark <= sl * 1.002 : mark >= sl * 0.998)) return "stop-loss";
    if (tp !== null && (p.size > 0 ? mark >= tp * 0.998 : mark <= tp * 1.002)) return "take-profit";
    return "own-position";
  }
  /** Leader symbols (in this copy's books) that map to a SoDEX market. */
  leaderSymbolsFor(s, sodexSymbol) {
    const st = this.stateOf(s);
    return Object.keys(st.leaderPos).filter((l) => this.markets.sodexMarketFor(s.settings.leader.venue, l)?.name === sodexSymbol);
  }
  async ensureLeverage(s, market, sink) {
    const policy = this.host.policyFor(s);
    const leverage = effectiveLeverage(s.settings.maxLeverage, policy, market.maxLeverage);
    const k = `${s.owner}|${market.name}`;
    const want = { leverage, margin: s.settings.marginMode };
    const had = this.leverageSet.get(k);
    if (had && had.leverage === want.leverage && had.margin === want.margin) return;
    if (this.followers.get(s.owner)?.positions[market.name] && !this.stateOf(s).owned[market.name]) return;
    try {
      await sink.setLeverage(s.accountId, market, leverage, s.settings.marginMode);
      this.leverageSet.set(k, want);
    } catch (e) {
      this.host.log.warn("copy: leverage not set", { owner: s.owner, symbol: market.name, leverage, error: String(e) });
      this.leverageSet.set(k, want);
    }
  }
  /* --------------------------------------------------------------- guards ----- */
  async runGuards() {
    for (const s of this.list()) {
      if (s.status !== "active" && s.status !== "paused") continue;
      const st = this.stateOf(s);
      if (!Object.keys(st.owned).length) {
        st.peakEquity = Math.max(st.peakEquity, copyEquity(s.settings, st, (m) => this.markets.mark(m)));
        continue;
      }
      const g = planGuards({
        sub: s,
        state: st,
        markets: (m) => this.markets.get(m),
        markOf: (m) => this.markets.mark(m),
        policy: this.host.policyFor(s),
        now: Date.now()
      });
      if (g.peak !== st.peakEquity) {
        st.peakEquity = g.peak;
        this.dirty.add(s.id);
      }
      if (!g.intents.length && !g.halt) continue;
      const now = Date.now();
      const intents = g.intents.filter((i) => !this.pending.some((p) => p.subId === s.id && p.symbol === i.symbol && p.reduceOnly && p.until > now));
      const byMarket = /* @__PURE__ */ new Map();
      for (const i of intents) byMarket.set(i.symbol, [...byMarket.get(i.symbol) ?? [], i]);
      this.enqueue(s.owner, async () => {
        for (const [sym, list] of byMarket) {
          const m = this.markets.get(sym);
          if (m) await this.execute(s, m, list, this.markets.mark(sym) ?? Number(list[0].limitPrice), null);
        }
        for (const [sym, why] of Object.entries(g.closed)) for (const lsym of this.leaderSymbolsFor(s, sym)) st.detached[lsym] = why;
        if (g.halt) await this.setStatus(s.id, "halted", `Your drawdown stop (${Math.round((s.settings.drawdownStopPct ?? 0) * 100)}%) closed this copy.`);
      });
    }
  }
  async closeAll(s, leg) {
    const st = this.stateOf(s);
    const tag = `${leg}:${Date.now()}`;
    await new Promise((resolve2) => {
      this.enqueue(s.owner, async () => {
        for (const [sym, p] of Object.entries(st.owned)) {
          const m = this.markets.get(sym);
          const mark = this.markets.mark(sym);
          if (!m || mark === null) continue;
          const q = floorQuantity(p.size, m);
          if (q === "0") continue;
          const side = p.size > 0 ? "sell" : "buy";
          const clOrdID = clientOrderId(s.id, `${tag}:${sym}`, leg);
          await this.execute(s, m, [{ symbol: sym, side, quantity: q, limitPrice: limitPrice(side, mark, Math.max(100, s.settings.slippageBps), m, mark), reduceOnly: true, leg, notionalUsd: Number(q) * mark, clampedBy: null, clOrdID }], mark, null);
        }
        resolve2();
      });
    });
  }
  /* -------------------------------------------------- SoDEX position stops ----- */
  scheduleStops(s, symbol2) {
    if (s.settings.paper || s.settings.stopLossPct === null && s.settings.takeProfitPct === null) return;
    const k = `${s.id}|${symbol2}`;
    timers.cancel(this.stopTimers.get(k));
    this.stopTimers.set(
      k,
      timers.after(2e3, () => {
        this.stopTimers.delete(k);
        this.enqueue(s.owner, () => this.refreshStops(s.id, symbol2));
      })
    );
  }
  /** Keep one SoDEX stop-loss (and take-profit) per copied position, sized to it. */
  async refreshStops(subId, symbol2) {
    const s = this.subs.get(subId);
    if (!s || s.status === "stopped") return;
    const st = this.stateOf(s);
    const sink = this.host.sinkFor(s);
    const m = this.markets.get(symbol2);
    if (!sink || sink.paper || !m) return;
    const p = st.owned[symbol2];
    const cur = st.stops[symbol2];
    if (p && cur && Math.abs(cur.size - p.size) < 1e-12) return;
    if (cur) {
      for (const id of [cur.sl, cur.tp]) if (id) await sink.cancel(s.accountId, m, id).catch((e) => this.host.log.warn("copy: stop not cancelled", { id, error: String(e) }));
      delete st.stops[symbol2];
    }
    if (!p) return;
    const q = floorQuantity(p.size, m);
    if (q === "0") return;
    const lev = effectiveLeverage(s.settings.maxLeverage, this.host.policyFor(s), m.maxLeverage);
    const builder = await this.host.builderFor(s).catch(() => null);
    const next = { sl: null, tp: null, size: p.size, at: Date.now() };
    for (const kind of ["stop-loss", "take-profit"]) {
      const trigger = guardTrigger(kind, p, s.settings, lev);
      if (trigger === null) continue;
      const clOrdID = `vds-${bytesToHex2(keccak256(utf8(`${s.id}|${symbol2}|${kind}|${p.size}|${next.at}`))).slice(2, 26)}`;
      const r = await sink.placeStop(s.accountId, m, { clOrdID, side: p.size > 0 ? "sell" : "buy", quantity: q, triggerPrice: snapPrice(trigger, m), kind }, builder);
      if (r.ok) next[kind === "stop-loss" ? "sl" : "tp"] = clOrdID;
      else await this.activity(s, { kind: "error", reason: `${kind}-not-placed`, symbol: symbol2, detail: r.error });
    }
    st.stops[symbol2] = next;
    this.dirty.add(s.id);
  }
  cancelStops(s, symbol2) {
    if (s.settings.paper || !this.stateOf(s).stops[symbol2]) return;
    this.enqueue(s.owner, () => this.refreshStops(s.id, symbol2));
  }
  cancelAllStops(s) {
    for (const sym of Object.keys(this.stateOf(s).stops)) {
      this.enqueue(s.owner, async () => {
        const st = this.stateOf(s);
        const cur = st.stops[sym];
        const sink = this.host.sinkFor(s);
        const m = this.markets.get(sym);
        if (!cur || !sink || !m) return;
        for (const id of [cur.sl, cur.tp]) if (id) await sink.cancel(s.accountId, m, id).catch(() => {
        });
        delete st.stops[sym];
        this.dirty.add(s.id);
      });
    }
  }
  /* ----------------------------------------------------------- readiness ----- */
  /** A live copy needs its key registered and a builder approval covering the copy fee. */
  async checkReady(s0) {
    const s = this.subs.get(s0.id);
    if (!s || s.settings.paper || s.status === "stopped" || s.status === "paused" || s.status === "halted") return;
    let problem = null;
    try {
      problem = await this.host.keyProblem?.(s) ?? null;
      if (!problem) {
        const builder = await this.host.builderFor(s);
        if (builder) {
          const approved = await this.host.sodex.builderApproval(s.owner, Number(builder.id));
          if (approved === null || approved < builder.fee) {
            problem = `Your SoDEX account does not approve the ValueDesk copy fee (${builder.fee / 10} bp). Approve it in copy setup.`;
          }
        }
      }
      const policy = this.host.policyFor(s);
      if (!problem && !policy.allowed) problem = policy.reason ?? "Copy trading is not available in your region.";
    } catch (e) {
      this.host.log.warn("copy: readiness check failed", { sub: s.id, error: String(e) });
      return;
    }
    if (problem && s.status !== "blocked") await this.setStatus(s.id, "blocked", problem);
    else if (problem && s.statusReason !== problem) await this.setStatus(s.id, "blocked", problem);
    else if (!problem && s.status === "blocked") await this.setStatus(s.id, "active", null);
  }
  /* ------------------------------------------------------------- leaders ----- */
  followedLeaders() {
    const seen = /* @__PURE__ */ new Map();
    for (const s of this.subs.values()) if (s.status !== "stopped") seen.set(lk(s.settings.leader), s.settings.leader);
    return [...seen.values()];
  }
  /** Point the feeds at the followed leaders (and start Hyperliquid's when one is needed). */
  async syncFeeds() {
    const leaders = this.followedLeaders();
    const sodex = [];
    for (const l of leaders.filter((x) => x.venue === "sodex")) {
      let id = this.sodexIds.get(l.address);
      if (id === void 0) {
        id = await this.host.sodex.accountId(l.address).catch(() => 0);
        if (id) this.sodexIds.set(l.address, id);
      }
      sodex.push({ ref: l, accountId: id });
    }
    this.sodexFeed?.setLeaders(sodex);
    const hl = leaders.filter((x) => x.venue === "hyperliquid");
    if (hl.length && !this.hlFeed && this.running) {
      if (this.host.hlMode === "firehose") this.hlCoins = await this.hyperliquidCoins();
      this.hlFeed = new HyperliquidFeed({
        factory: this.host.factory,
        book: this.leaders,
        mode: this.host.hlMode,
        coins: () => this.hlCoins,
        log: this.host.log,
        sink: {
          leader: (e) => this.onLeaderEvent(e),
          state: (_f, up) => {
            this.feedUp.hyperliquid = up;
            if (up) void this.reconcileAll();
          }
        }
      });
      this.hlFeed.start();
    }
    this.hlFeed?.setLeaders(hl);
    for (const l of leaders) if (!this.leaders.seeded(l)) await this.seedLeader(l);
  }
  async hyperliquidCoins() {
    try {
      const meta = await this.host.hyperliquid.post({ type: "meta" });
      return (meta.universe ?? []).filter((u) => u.name && !u.isDelisted).map((u) => u.name);
    } catch (e) {
      this.host.log.warn("copy: hyperliquid coin list failed", { error: String(e) });
      return [];
    }
  }
  async readLeader(l) {
    return l.venue === "sodex" ? this.host.sodex.leaderPositions(l.address) : this.host.hyperliquid.leaderPositions(l.address);
  }
  async seedLeader(l) {
    if (this.leaders.seeded(l)) return;
    try {
      const r = await this.readLeader(l);
      this.leaders.resync(l, r.positions, r.equity, r.marks, Date.now(), (sym) => this.priceFor(l.venue, sym));
    } catch (e) {
      this.host.log.warn("copy: leader read failed", { leader: lk(l), error: String(e) });
    }
  }
  reconciling = false;
  /** Re-read every followed leader: what the stream missed becomes a 'reconcile' event. */
  async reconcileAll() {
    if (this.reconciling || !this.running) return;
    this.reconciling = true;
    try {
      for (const l of this.followedLeaders()) {
        try {
          const r = await this.readLeader(l);
          const events = this.leaders.resync(l, r.positions, r.equity, r.marks, Date.now(), (sym) => this.priceFor(l.venue, sym));
          const eq = this.leaders.equity(l);
          for (const s of this.list()) {
            if (lk(s.settings.leader) !== lk(l)) continue;
            const st = this.stateOf(s);
            if (eq) {
              st.leaderEquity = eq.value;
              st.leaderEquityAt = eq.at;
            }
            st.lastReconcileAt = Date.now();
            this.dirty.add(s.id);
          }
          for (const e of events) this.onLeaderEvent(e);
        } catch (e) {
          this.host.log.warn("copy: reconcile read failed", { leader: lk(l), error: String(e) });
        }
      }
    } finally {
      this.reconciling = false;
    }
  }
  /** A price for a leader market: the SoDEX mark of the market it maps to. */
  priceFor(venue, leaderSymbol) {
    const m = this.markets.sodexMarketFor(venue, leaderSymbol);
    return m ? this.markets.mark(m.name, 10 * 6e4) : null;
  }
  async loadMarkets() {
    try {
      const list = await this.host.sodex.markets();
      if (list.length) this.markets.load(list);
      for (const p of await this.host.sodex.markPrices()) this.markets.setMark(p.symbol, p.price);
    } catch (e) {
      this.host.log.warn("copy: market list failed", { error: String(e) });
    }
  }
  /* ---------------------------------------------------------------- books ----- */
  stateOf(s) {
    let st = this.states.get(s.id);
    if (!st) this.states.set(s.id, st = freshState(s.id, s.settings.allocationUsd));
    return st;
  }
  live(s) {
    return !s.settings.paper;
  }
  need(id) {
    const s = this.subs.get(id);
    if (!s) throw new Error("No such copy.");
    return s;
  }
  async flush() {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const st = this.states.get(id);
      if (st) await this.host.store.saveState(st).catch((e) => this.host.log.error("copy: state not saved", { sub: id, error: String(e) }));
      this.host.onChange?.(id);
    }
  }
  async activity(s, e) {
    const entry = {
      id: randomId("a"),
      subId: s.id,
      owner: s.owner,
      at: Date.now(),
      detail: null,
      symbol: null,
      side: null,
      size: null,
      price: null,
      notionalUsd: null,
      reduceOnly: null,
      clOrdID: null,
      orderId: null,
      builderFee: null,
      leader: null,
      paper: s.settings.paper,
      ...e
    };
    await this.host.store.addActivity(entry).catch((err) => this.host.log.error("copy: activity not saved", { error: String(err) }));
    this.host.onChange?.(s.id);
  }
};

// packages/copy-engine/src/api.ts
var COPY_DOMAIN = { name: "ValueDesk Copy", version: "1" };
var COPY_TERMS_EXECUTOR = "valuedesk-copy-terms";
var COPY_ACTIONS = ["session", "accept-terms", "create-key", "delete-key", "subscribe", "update", "pause", "resume", "stop", "stop-all", "algo-start", "algo-action"];
var COPY_REQUEST_FIELDS = [
  { name: "action", type: "string" },
  { name: "owner", type: "address" },
  { name: "executor", type: "string" },
  { name: "payload", type: "string" },
  { name: "nonce", type: "uint64" },
  { name: "deadline", type: "uint64" }
];
function canonicalJSON(v) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => canonicalJSON(x === void 0 ? null : x)).join(",")}]`;
  const o = v;
  return `{${Object.keys(o).filter((k) => o[k] !== void 0).sort().map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`).join(",")}}`;
}
function copyRequestTypedData(r) {
  return {
    domain: { name: COPY_DOMAIN.name, version: COPY_DOMAIN.version, chainId: r.chainId, verifyingContract: ZERO_ADDRESS },
    types: {
      EIP712Domain: [
        { name: "name", type: "string" },
        { name: "version", type: "string" },
        { name: "chainId", type: "uint256" },
        { name: "verifyingContract", type: "address" }
      ],
      CopyRequest: COPY_REQUEST_FIELDS
    },
    primaryType: "CopyRequest",
    message: {
      action: r.action,
      owner: r.owner.toLowerCase(),
      executor: r.executor,
      payload: r.payload,
      nonce: r.nonce,
      deadline: r.deadline
    }
  };
}
var copyRequestDigest = (r) => bytesToHex2(hashTypedData(copyRequestTypedData(r)));
var REQUEST_TTL_MS = 5 * 6e4;
var TERMS_TTL_MS = 365 * 864e5;
var MAX_WINDOW_MS = (action2) => action2 === "accept-terms" ? TERMS_TTL_MS + 864e5 : 60 * 6e4;
var ADDRESS3 = /^0x[0-9a-f]{40}$/;
function verifyCopyRequest(r, o) {
  const now = o.now ?? Date.now();
  if (!r || typeof r !== "object") return { ok: false, error: "missing signed request" };
  const q = r;
  const action2 = q.action;
  if (!COPY_ACTIONS.includes(action2)) return { ok: false, error: "unknown action" };
  const owner = typeof q.owner === "string" ? q.owner.toLowerCase() : "";
  if (!ADDRESS3.test(owner)) return { ok: false, error: "owner must be a 0x address" };
  if (q.executor !== o.executor) return { ok: false, error: "this request was signed for another executor" };
  if (typeof q.payload !== "string" || q.payload.length > 16384) return { ok: false, error: "payload must be a JSON string under 16 KB" };
  if (typeof q.nonce !== "string" || !/^\d{1,16}$/.test(q.nonce)) return { ok: false, error: "nonce must be a decimal string" };
  if (typeof q.deadline !== "string" || !/^\d{1,16}$/.test(q.deadline)) return { ok: false, error: "deadline must be a decimal string" };
  const chainId = Number(q.chainId);
  if (!Number.isSafeInteger(chainId) || chainId <= 0) return { ok: false, error: "chainId must be a positive integer" };
  if (typeof q.signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(q.signature)) return { ok: false, error: "signature must be 65 bytes of hex" };
  const nonce = Number(q.nonce);
  const deadline = Number(q.deadline);
  if (deadline < now) return { ok: false, error: "this request has expired; sign it again" };
  if (deadline - nonce > MAX_WINDOW_MS(action2)) return { ok: false, error: "this request is valid for longer than allowed" };
  const skew = o.maxAgeMs ?? 15 * 6e4;
  if (nonce - now > skew || action2 !== "accept-terms" && now - nonce > skew) return { ok: false, error: "the request time is too far from now; check your clock" };
  let payload;
  try {
    payload = JSON.parse(q.payload);
  } catch {
    return { ok: false, error: "payload is not JSON" };
  }
  if (canonicalJSON(payload) !== q.payload) return { ok: false, error: "payload is not in canonical form" };
  const req = { action: action2, owner, executor: o.executor, payload: q.payload, nonce: q.nonce, deadline: q.deadline, chainId };
  const digest = copyRequestDigest(req);
  let signer;
  try {
    signer = recoverAddress(hexToBytes2(digest), hexToBytes2(q.signature)).toLowerCase();
  } catch {
    return { ok: false, error: "the signature cannot be read" };
  }
  if (signer !== owner) return { ok: false, error: "the signature is not from this wallet" };
  return { ok: true, digest, payload };
}
var EXECUTOR_FEATURES = ["counter"];

// packages/copy-engine/src/algo/types.ts
var ALGO_KINDS = ["twap", "vwap", "pov", "iceberg", "chase", "scale", "dca", "swarm", "conditional", "trailing", "basket", "bracket"];
var FINAL_STATUSES = /* @__PURE__ */ new Set(["done", "cancelled", "expired", "failed"]);

// packages/copy-engine/src/algo/math.ts
var DAY_MS2 = 864e5;
function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = a + 1831565813 >>> 0;
    let t = a;
    t = Math.imul(t ^ t >>> 15, t | 1);
    t ^= t + Math.imul(t ^ t >>> 7, t | 61);
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
var newSeed = () => Math.floor(Math.random() * 4294967295) >>> 0;
var jitter = (v, share, rand) => share > 0 ? v * (1 + (rand() * 2 - 1) * share) : v;
function normalise(w) {
  const pos = w.map((x) => Number.isFinite(x) && x > 0 ? x : 0);
  const sum = pos.reduce((a, b) => a + b, 0);
  if (!(sum > 0)) return w.map(() => 1 / Math.max(1, w.length));
  return pos.map((x) => x / sum);
}
function curveWeights(n, urgency, sizeJitter, rand) {
  const k = Math.max(-1, Math.min(1, urgency)) * 3;
  const w = [];
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0 : i / (n - 1);
    w.push(jitter(Math.exp(-k * x), sizeJitter, rand));
  }
  return normalise(w);
}
function sliceTimes(start, durationMs, n, timeJitter, rand) {
  const step = durationMs / n;
  const out = [];
  let prev = start - 1;
  for (let i = 0; i < n; i++) {
    let t = start + i * step;
    if (i > 0 && timeJitter > 0) t += (rand() * 2 - 1) * timeJitter * step;
    t = Math.max(prev + 1, Math.min(start + durationMs - 1, t));
    out.push(Math.round(t));
    prev = t;
  }
  return out;
}
function dueShare(times, weights, now) {
  let s = 0;
  for (let i = 0; i < times.length; i++) if (times[i] <= now) s += weights[i] ?? 0;
  return Math.min(1, s);
}
function nextSlice(times, now) {
  for (let i = 0; i < times.length; i++) if (times[i] > now) return i;
  return -1;
}
function allocateSteps(total, weights, step) {
  const units = Math.floor(total / step + 1e-9);
  const w = normalise(weights);
  const raw = w.map((x) => x * units);
  const out = raw.map((x) => Math.floor(x + 1e-9));
  let left = units - out.reduce((a, b) => a + b, 0);
  const order = raw.map((x, i) => ({ i, f: x - Math.floor(x + 1e-9) })).sort((a, b) => b.f - a.f || a.i - b.i);
  for (let j = 0; left > 0 && order.length; j = (j + 1) % order.length, left--) out[order[j].i] += 1;
  return out.map((u) => u * step);
}
var isWeekend = (t) => {
  const d = new Date(t).getUTCDay();
  return d === 0 || d === 6;
};
function median(xs) {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function volumeProfile(candles, candleMs, start, durationMs, slices, lookbackDays) {
  const byBucket = /* @__PURE__ */ new Map();
  for (const c of candles) if (Number.isFinite(c.v) && c.v >= 0) byBucket.set(Math.floor(c.t / candleMs) * candleMs, c.v);
  const volIn = (a, b) => {
    let sum = 0;
    let seen = false;
    for (let t = Math.floor(a / candleMs) * candleMs; t < b; t += candleMs) {
      const v = byBucket.get(t);
      if (v === void 0) continue;
      seen = true;
      const lo = Math.max(a, t);
      const hi = Math.min(b, t + candleMs);
      if (hi > lo) sum += v * (hi - lo) / candleMs;
    }
    return seen ? sum : null;
  };
  const step = durationMs / slices;
  const matchDays = lookbackDays >= 14;
  const expected = [];
  const daysSeen = /* @__PURE__ */ new Set();
  for (let i = 0; i < slices; i++) {
    const a = start + i * step;
    const b = a + step;
    const same = [];
    const all = [];
    for (let d = 1; d <= lookbackDays; d++) {
      const v = volIn(a - d * DAY_MS2, b - d * DAY_MS2);
      if (v === null) continue;
      daysSeen.add(d);
      all.push(v);
      if (!matchDays || isWeekend(a - d * DAY_MS2) === isWeekend(a)) same.push(v);
    }
    expected.push(median(same.length >= 3 ? same : all));
  }
  const mean = expected.reduce((x, y) => x + y, 0) / Math.max(1, expected.length);
  const floored = expected.map((v) => Math.max(v, mean / 10));
  return { weights: normalise(floored), expected: floored, days: daysSeen.size };
}
function profileCandles(lookbackDays) {
  return lookbackDays > 28 ? { interval: "30m", ms: 30 * 6e4 } : { interval: "15m", ms: 15 * 6e4 };
}
function adaptiveShare(staticShare, marketSoFar, expectedTotal) {
  if (!(expectedTotal > 0) || staticShare >= 1) return Math.min(1, staticShare);
  const live = marketSoFar / expectedTotal;
  const blend = 0.5 * staticShare + 0.5 * live;
  return Math.min(1, Math.max(staticShare * 0.5, Math.min(staticShare * 2, blend)));
}
function ladderWeights(n, distribution, skew, sizeJitter, rand) {
  const w = [];
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0 : i / (n - 1);
    let v = 1;
    if (distribution === "linear") v = 1 + (skew - 1) * x;
    else if (distribution === "exponential") v = Math.pow(skew, x);
    else if (distribution === "bell") v = Math.exp(-0.5 * Math.pow((x - 0.5) / 0.22, 2));
    w.push(jitter(Math.max(v, 1e-6), sizeJitter, rand));
  }
  return normalise(w);
}
function ladderPrices(from, to, n, spacing, tickSize) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const x = n <= 1 ? 0 : i / (n - 1);
    let p;
    if (spacing === "geometric" && from > 0 && to > 0) p = from * Math.pow(to / from, x);
    else {
      const f = spacing === "front" ? x * x : spacing === "back" ? 1 - (1 - x) * (1 - x) : x;
      p = from + (to - from) * f;
    }
    const s = snapNearest(p, tickSize);
    if (!out.includes(s)) out.push(s);
  }
  return out;
}
var dec2 = (n) => {
  const s = Number(n.toPrecision(12)).toString();
  if (!/e/i.test(s)) return s;
  return Number(n.toPrecision(12)).toFixed(20).replace(/0+$/, "").replace(/\.$/, "");
};
function snapNearest(p, tickSize) {
  return Number(roundToStep(dec2(Math.max(p, 0)), tickSize, "nearest"));
}
function snapDown(p, tickSize) {
  return Number(roundToStep(dec2(Math.max(p, 0)), tickSize, "floor"));
}
function snapUp(p, tickSize) {
  const down = snapDown(p, tickSize);
  const tick = Number(tickSize);
  return down + 1e-12 < p ? Number(roundToStep(dec2(down + tick), tickSize, "nearest")) : down;
}
var mid = (q) => (q.bid + q.ask) / 2;
var spreadBps = (q) => (q.ask - q.bid) / mid(q) * 1e4;
function makerPrice(side, q, offsetTicks, offsetBps, m, limit) {
  const tick = Number(m.tickSize);
  let p;
  if (side === "buy") {
    p = offsetBps !== null ? q.bid * (1 - offsetBps / 1e4) : q.bid - offsetTicks * tick;
    p = Math.min(p, q.ask - tick);
    if (limit !== null) p = Math.min(p, limit);
    return snapDown(p, m.tickSize);
  }
  p = offsetBps !== null ? q.ask * (1 + offsetBps / 1e4) : q.ask + offsetTicks * tick;
  p = Math.max(p, q.bid + tick);
  if (limit !== null) p = Math.max(p, limit);
  return snapUp(p, m.tickSize);
}
function takerPrice(side, q, slippageBps, m, mark, limit) {
  const touch = side === "buy" ? q.ask : q.bid;
  let p = Number(limitPrice(side, touch, slippageBps, m, mark));
  if (limit !== null) {
    if (side === "buy" && limit < touch) return null;
    if (side === "sell" && limit > touch) return null;
    p = side === "buy" ? Math.min(p, snapDown(limit, m.tickSize)) : Math.max(p, snapUp(limit, m.tickSize));
  }
  return p;
}
function minChildQty(m, price2) {
  const step = Number(m.stepSize);
  const minQ = Math.max(step, Number(m.minQuantity) || 0);
  const byValue = price2 > 0 ? Math.ceil(m.minNotional / price2 / step - 1e-9) * step : minQ;
  return Math.max(minQ, byValue);
}
var floorStep = (q, m) => {
  const step = Number(m.stepSize);
  return Math.floor(q / step + 1e-9) * step;
};
var DEFAULT_EXEC = { style: "hybrid", slippageBps: 30, offsetTicks: 0, chaseTicks: 2, makerShare: 0.6 };
function trail(s, side, price2, o) {
  let { armed, extreme } = s;
  if (!armed) {
    const a = o.activationPrice;
    armed = a === null || (side === "sell" ? price2 >= a : price2 <= a);
    if (armed) extreme = price2;
  }
  if (!armed) return { state: { armed, extreme }, stop: null, fired: false };
  extreme = extreme === null ? price2 : side === "sell" ? Math.max(extreme, price2) : Math.min(extreme, price2);
  const dist = o.trailAbs !== null ? o.trailAbs : extreme * (o.trailPct ?? 0);
  const stop = side === "sell" ? extreme - dist : extreme + dist;
  const fired = side === "sell" ? price2 <= stop : price2 >= stop;
  return { state: { armed, extreme }, stop, fired };
}

// packages/copy-engine/src/algo/spec.ts
var AlgoSpecError = class extends Error {
  constructor(message, errors) {
    super(message);
    this.errors = errors;
  }
  errors;
  name = "AlgoSpecError";
};
var MIN = 6e4;
var HOUR = 60 * MIN;
var DAY = 24 * HOUR;
var ALGO_LIMITS = {
  twap: { durationMs: { min: MIN, max: 30 * DAY }, slices: { min: 1, max: 2e3 }, minIntervalMs: 5e3 },
  vwap: { durationMs: { min: 15 * MIN, max: 7 * DAY }, slices: { min: 2, max: 2e3 }, lookbackDays: { min: 1, max: 56 }, minIntervalMs: 5e3 },
  pov: { rate: { min: 0.01, max: 0.5 } },
  iceberg: { refillMs: { min: 0, max: 10 * MIN } },
  chase: { offsetTicks: { min: -5, max: 1e4 }, offsetBps: { min: 0, max: 2e3 }, chaseTicks: { min: 1, max: 1e4 }, maxChaseBps: { min: 1, max: 5e3 }, timeoutMs: { min: 5e3, max: 7 * DAY }, minRepriceMs: { min: 250, max: MIN } },
  scale: { orders: { min: 2, max: 100 }, skew: { min: 0.1, max: 10 }, sizeJitter: { min: 0, max: 0.3 } },
  dca: { perOrderUsd: { min: 10, max: 1e6 }, orders: { min: 2, max: 1e3 }, intervalMs: { min: MIN, max: 30 * DAY }, dipPct: { min: 0.01, max: 0.9 }, dipMultiplier: { min: 1, max: 5 } },
  swarm: { clips: { min: 2, max: 200 }, inFlight: { min: 1, max: 20 }, waveMs: { min: 0, max: MIN }, sizeJitter: { min: 0, max: 0.9 }, retries: { min: 0, max: 5 } },
  conditional: { conditions: { min: 1, max: 5 }, holdMs: { min: 0, max: HOUR }, windowMs: { min: 5e3, max: HOUR } },
  trailing: { trailPct: { min: 1e-3, max: 0.5 }, chaseMs: { min: 1e3, max: 10 * MIN } },
  basket: { legs: { min: 2, max: 10 }, legUsd: { min: 10, max: 1e7 } },
  exitPct: { min: 1e-3, max: 10 },
  exec: { slippageBps: { min: 1, max: 500 }, offsetTicks: { min: -5, max: 1e4 }, chaseTicks: { min: 1, max: 1e4 }, makerShare: { min: 0.1, max: 0.95 } },
  jitter: { min: 0, max: 0.5 },
  maxSpreadBps: { min: 1, max: 5e3 },
  leverage: { min: 1, max: 100 },
  label: 40
};
var isObj = (v) => !!v && typeof v === "object" && !Array.isArray(v);
function num2(o, key2, label, lim, e, path = key2) {
  const raw = o[key2];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n)) {
    e[path] = `${label} must be a number.`;
    return NaN;
  }
  if (n < lim.min || n > lim.max) e[path] = `${label} must be between ${lim.min} and ${lim.max}.`;
  return n;
}
function int(o, key2, label, lim, e, path = key2) {
  const n = num2(o, key2, label, lim, e, path);
  if (Number.isFinite(n) && !Number.isInteger(n)) e[path] = `${label} must be a whole number.`;
  return n;
}
function opt(o, key2, label, lim, e, path = key2) {
  const v = o[key2];
  if (v === null || v === void 0 || v === "") return null;
  return num2(o, key2, label, lim, e, path);
}
function price(o, key2, label, e, path = key2) {
  const raw = o[key2];
  const n = typeof raw === "string" && raw.trim() !== "" ? Number(raw) : raw;
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0 || n > 1e12) {
    e[path] = `${label} must be a price above 0.`;
    return NaN;
  }
  return n;
}
function optPrice(o, key2, label, e, path = key2) {
  const v = o[key2];
  if (v === null || v === void 0 || v === "") return null;
  return price(o, key2, label, e, path);
}
function time(o, key2, label, e, path = key2) {
  const v = o[key2];
  if (v === null || v === void 0 || v === "") return null;
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n < 15e11 || n > 4e12) {
    e[path] = `${label} must be a time.`;
    return null;
  }
  return n;
}
function qty(o, key2, label, e, path = key2) {
  const raw = o[key2];
  const s = typeof raw === "number" && Number.isFinite(raw) ? String(raw) : typeof raw === "string" ? raw.trim() : "";
  if (!/^\d+(\.\d+)?$/.test(s) || !(Number(s) > 0)) {
    e[path] = `${label} must be a positive amount.`;
    return "0";
  }
  if (Number(s) > 1e12) {
    e[path] = `${label} is too large.`;
    return "0";
  }
  return canonicalDecimal(s);
}
function optQty(o, key2, label, e, path = key2) {
  const v = o[key2];
  if (v === null || v === void 0 || v === "") return null;
  return qty(o, key2, label, e, path);
}
function oneOf(o, key2, label, allowed, fallback, e, path = key2) {
  const v = o[key2];
  if (v === void 0 || v === null || v === "") return fallback;
  if (typeof v === "string" && allowed.includes(v)) return v;
  e[path] = `${label} must be one of ${allowed.join(", ")}.`;
  return fallback;
}
var bool = (o, key2, fallback = false) => typeof o[key2] === "boolean" ? o[key2] : fallback;
var SYMBOL = /^[A-Z0-9]{1,24}-USD$/;
function symbol(o, key2, e, path = key2) {
  const s = typeof o[key2] === "string" ? o[key2].trim().toUpperCase() : "";
  if (!SYMBOL.test(s)) e[path] = "Choose a SoDEX perps market (like BTC-USD).";
  return s;
}
var BOUND_ACTIONS = ["hold", "stop", "rush"];
function bound(o, key2, label, e) {
  const v = o[key2];
  if (v === null || v === void 0) return null;
  if (!isObj(v)) {
    e[key2] = `${label} must be a price and what to do there.`;
    return null;
  }
  return { price: price(v, "price", `${label} price`, e, `${key2}.price`), then: oneOf(v, "then", `${label} action`, BOUND_ACTIONS, "hold", e, `${key2}.then`) };
}
function exec(v, e, path) {
  const o = isObj(v) ? v : {};
  const L = ALGO_LIMITS.exec;
  return {
    style: oneOf(o, "style", "Execution", ["taker", "maker", "hybrid"], DEFAULT_EXEC.style, e, `${path}.style`),
    slippageBps: o.slippageBps === void 0 ? DEFAULT_EXEC.slippageBps : num2(o, "slippageBps", "Max slippage", L.slippageBps, e, `${path}.slippageBps`),
    offsetTicks: o.offsetTicks === void 0 ? DEFAULT_EXEC.offsetTicks : int(o, "offsetTicks", "Offset", L.offsetTicks, e, `${path}.offsetTicks`),
    chaseTicks: o.chaseTicks === void 0 ? DEFAULT_EXEC.chaseTicks : int(o, "chaseTicks", "Re-price distance", L.chaseTicks, e, `${path}.chaseTicks`),
    makerShare: o.makerShare === void 0 ? DEFAULT_EXEC.makerShare : num2(o, "makerShare", "Resting share", L.makerShare, e, `${path}.makerShare`)
  };
}
function exits(o, side, e) {
  const v = o.exits;
  if (v === null || v === void 0) return null;
  if (!isObj(v)) {
    e.exits = "Exits must be a take-profit and/or a stop-loss.";
    return null;
  }
  const x = {
    tpPrice: optPrice(v, "tpPrice", "Take-profit price", e, "exits.tpPrice"),
    slPrice: optPrice(v, "slPrice", "Stop-loss price", e, "exits.slPrice"),
    tpPct: opt(v, "tpPct", "Take-profit distance", ALGO_LIMITS.exitPct, e, "exits.tpPct"),
    slPct: opt(v, "slPct", "Stop-loss distance", { min: ALGO_LIMITS.exitPct.min, max: 0.99 }, e, "exits.slPct")
  };
  if (x.tpPrice !== null && x.tpPct !== null) e["exits.tpPct"] = "Set the take-profit as a price or a distance, not both.";
  if (x.slPrice !== null && x.slPct !== null) e["exits.slPct"] = "Set the stop-loss as a price or a distance, not both.";
  if (x.tpPrice !== null && x.slPrice !== null && (side === "buy" ? x.tpPrice <= x.slPrice : x.tpPrice >= x.slPrice)) {
    e["exits.tpPrice"] = side === "buy" ? "A long's take-profit must be above its stop-loss." : "A short's take-profit must be below its stop-loss.";
  }
  return x.tpPrice === null && x.slPrice === null && x.tpPct === null && x.slPct === null ? null : x;
}
function base(o, kind, e) {
  const label = typeof o.label === "string" ? o.label.trim().slice(0, ALGO_LIMITS.label) : "";
  const marginMode = o.marginMode === null || o.marginMode === void 0 ? null : oneOf(o, "marginMode", "Margin mode", ["cross", "isolated"], "cross", e);
  const b = {
    kind,
    symbol: symbol(o, "symbol", e),
    side: oneOf(o, "side", "Side", ["buy", "sell"], "buy", e),
    reduceOnly: bool(o, "reduceOnly"),
    limitPrice: optPrice(o, "limitPrice", "Limit price", e),
    upper: bound(o, "upper", "Upper bound", e),
    lower: bound(o, "lower", "Lower bound", e),
    triggerPrice: optPrice(o, "triggerPrice", "Start price", e),
    startAt: time(o, "startAt", "Start time", e),
    maxSpreadBps: opt(o, "maxSpreadBps", "Max spread", ALGO_LIMITS.maxSpreadBps, e),
    leverage: o.leverage === null || o.leverage === void 0 || o.leverage === "" ? null : int(o, "leverage", "Leverage", ALGO_LIMITS.leverage, e),
    marginMode,
    paper: bool(o, "paper"),
    label: label || null,
    exits: null
  };
  b.exits = exits(o, b.side, e);
  if (b.exits && b.reduceOnly) e.exits = "A reduce-only order opens nothing to protect: no exits on it.";
  if (b.upper && b.lower && b.upper.price <= b.lower.price) e.upper = "The upper bound must be above the lower bound.";
  return b;
}
var SOURCES = ["mark", "last", "mid", "index"];
function condition(v, e, path) {
  if (!isObj(v)) {
    e[path] = "Each condition needs a type.";
    return null;
  }
  const L = ALGO_LIMITS.conditional;
  const type = v.type;
  const sym = () => symbol(v, "symbol", e, `${path}.symbol`);
  const src = () => oneOf(v, "source", "Price source", SOURCES, "mark", e, `${path}.source`);
  const op = () => oneOf(v, "op", "Comparison", ["above", "below"], "above", e, `${path}.op`);
  const dir3 = () => oneOf(v, "dir", "Direction", ["up", "down", "either"], "either", e, `${path}.dir`);
  const pct = () => num2(v, "pct", "Move", { min: 1e-4, max: 10 }, e, `${path}.pct`);
  const win = () => int(v, "windowMs", "Window", L.windowMs, e, `${path}.windowMs`);
  switch (type) {
    case "price":
      return { type, symbol: sym(), source: src(), op: op(), value: price(v, "value", "Price", e, `${path}.value`) };
    case "cross":
      return { type, symbol: sym(), source: src(), dir: oneOf(v, "dir", "Direction", ["up", "down"], "up", e, `${path}.dir`), value: price(v, "value", "Price", e, `${path}.value`) };
    case "move":
      return { type, symbol: sym(), source: src(), dir: dir3(), pct: pct(), windowMs: win() };
    case "funding":
      return { type, symbol: sym(), op: op(), value: num2(v, "value", "Funding rate", { min: -1, max: 1 }, e, `${path}.value`) };
    case "oi":
      return { type, symbol: sym(), dir: dir3(), pct: pct(), windowMs: win() };
    case "spread":
      return { type, symbol: sym(), op: op(), bps: num2(v, "bps", "Spread", { min: 0, max: 1e4 }, e, `${path}.bps`) };
    case "volume":
      return { type, symbol: sym(), windowMs: win(), aboveUsd: num2(v, "aboveUsd", "Volume", { min: 1, max: 1e12 }, e, `${path}.aboveUsd`) };
    case "ratio": {
      const other = symbol(v, "other", e, `${path}.other`);
      return { type, symbol: sym(), other, op: op(), value: num2(v, "value", "Ratio", { min: 1e-12, max: 1e12 }, e, `${path}.value`) };
    }
    case "position": {
      const pop = oneOf(v, "op", "Position", ["long", "short", "flat", "sizeAbove", "sizeBelow", "pnlAbove", "pnlBelow"], "long", e, `${path}.op`);
      const needs = pop === "sizeAbove" || pop === "sizeBelow" || pop === "pnlAbove" || pop === "pnlBelow";
      const value = needs ? num2(v, "value", pop.startsWith("pnl") ? "PnL" : "Size", pop.startsWith("pnl") ? { min: -1e12, max: 1e12 } : { min: 0, max: 1e12 }, e, `${path}.value`) : 0;
      return { type, symbol: sym(), op: pop, value };
    }
    case "time": {
      const at = time(v, "at", "Time", e, `${path}.at`);
      return { type, at: at ?? 0 };
    }
    default:
      e[path] = "Unknown condition.";
      return null;
  }
}
function action(v, e, depth) {
  const o = isObj(v) ? v : {};
  const t = o.type;
  if (t === "market") return { type: t, quantity: qty(o, "quantity", "Size", e, "then.quantity"), slippageBps: num2(o, "slippageBps", "Max slippage", ALGO_LIMITS.exec.slippageBps, e, "then.slippageBps") };
  if (t === "limit") return { type: t, quantity: qty(o, "quantity", "Size", e, "then.quantity"), price: price(o, "price", "Price", e, "then.price"), postOnly: bool(o, "postOnly") };
  if (t === "close") return { type: t, share: num2(o, "share", "Share of the position", { min: 0.01, max: 1 }, e, "then.share"), slippageBps: num2(o, "slippageBps", "Max slippage", ALGO_LIMITS.exec.slippageBps, e, "then.slippageBps") };
  if (t === "algo") {
    if (depth > 0) {
      e.then = "A conditional cannot start another conditional.";
      return { type: "market", quantity: "0", slippageBps: 30 };
    }
    const inner = checkAlgoSpec(o.algo, depth + 1);
    for (const [k, m] of Object.entries(inner.errors)) e[`then.algo.${k}`] = m;
    if (inner.spec?.kind === "conditional") e.then = "A conditional cannot start another conditional.";
    return { type: "algo", algo: inner.spec ?? { kind: "twap" } };
  }
  e.then = "Choose what happens when the conditions hold.";
  return { type: "market", quantity: "0", slippageBps: 30 };
}
function checkAlgoSpec(input, depth = 0) {
  const e = {};
  if (!isObj(input)) return { spec: null, errors: { kind: "Choose an order type." } };
  const kind = input.kind;
  if (!ALGO_KINDS.includes(kind)) return { spec: null, errors: { kind: "Unknown order type." } };
  const o = input;
  const b = base(o, kind, e);
  const jit = (key2, label) => o[key2] === void 0 ? 0 : num2(o, key2, label, ALGO_LIMITS.jitter, e);
  const finish = () => oneOf(o, "finish", "At the end", ["take", "leave"], "take", e);
  let spec;
  switch (kind) {
    case "twap": {
      const L = ALGO_LIMITS.twap;
      const durationMs = int(o, "durationMs", "Duration", L.durationMs, e);
      const slices = int(o, "slices", "Slices", L.slices, e);
      if (durationMs / slices < L.minIntervalMs) e.slices = `At most one slice every ${L.minIntervalMs / 1e3} s: use at most ${Math.floor(durationMs / L.minIntervalMs)} slices.`;
      const closeShare = opt(o, "closeShare", "Share of the position", { min: 0.01, max: 1 }, e);
      const minSliceQty = optQty(o, "minSliceQty", "Smallest slice", e);
      const maxSliceQty = optQty(o, "maxSliceQty", "Largest slice", e);
      if (minSliceQty !== null && maxSliceQty !== null && Number(minSliceQty) > Number(maxSliceQty)) e.minSliceQty = "The smallest slice cannot be larger than the largest.";
      if (closeShare !== null && b.exits) e.exits = "A close opens nothing to protect: no exits on it.";
      spec = {
        ...b,
        kind,
        // A time-sliced close takes its size from the position when it starts: always reduce-only.
        reduceOnly: closeShare !== null ? true : b.reduceOnly,
        quantity: closeShare !== null ? "0" : qty(o, "quantity", "Size", e),
        closeShare,
        minSliceQty,
        maxSliceQty,
        durationMs,
        slices,
        urgency: o.urgency === void 0 ? 0 : num2(o, "urgency", "Urgency", { min: -1, max: 1 }, e),
        sizeJitter: jit("sizeJitter", "Size randomisation"),
        timeJitter: jit("timeJitter", "Time randomisation"),
        exec: exec(o.exec, e, "exec"),
        finish: finish(),
        maxParticipation: opt(o, "maxParticipation", "Max participation", { min: 0.01, max: 1 }, e)
      };
      break;
    }
    case "vwap": {
      const L = ALGO_LIMITS.vwap;
      const durationMs = int(o, "durationMs", "Duration", L.durationMs, e);
      const slices = int(o, "slices", "Slices", L.slices, e);
      if (durationMs / slices < L.minIntervalMs) e.slices = `At most one slice every ${L.minIntervalMs / 1e3} s: use at most ${Math.floor(durationMs / L.minIntervalMs)} slices.`;
      spec = {
        ...b,
        kind,
        quantity: qty(o, "quantity", "Size", e),
        durationMs,
        slices,
        lookbackDays: int(o, "lookbackDays", "History", L.lookbackDays, e),
        adaptive: bool(o, "adaptive", true),
        sizeJitter: jit("sizeJitter", "Size randomisation"),
        exec: exec(o.exec, e, "exec"),
        finish: finish(),
        maxParticipation: opt(o, "maxParticipation", "Max participation", { min: 0.01, max: 1 }, e)
      };
      break;
    }
    case "pov":
      spec = {
        ...b,
        kind,
        quantity: qty(o, "quantity", "Size", e),
        rate: num2(o, "rate", "Participation", ALGO_LIMITS.pov.rate, e),
        maxChildQty: optQty(o, "maxChildQty", "Largest child", e),
        endAt: time(o, "endAt", "End time", e),
        exec: exec(o.exec, e, "exec"),
        finish: finish()
      };
      break;
    case "iceberg": {
      const quantity = qty(o, "quantity", "Size", e);
      const displayQty = qty(o, "displayQty", "Visible size", e);
      if (Number(displayQty) > Number(quantity)) e.displayQty = "The visible size cannot be more than the whole size.";
      spec = {
        ...b,
        kind,
        quantity,
        displayQty,
        displayJitter: jit("displayJitter", "Visible size randomisation"),
        price: optPrice(o, "price", "Price", e),
        pegOffsetTicks: o.pegOffsetTicks === void 0 ? 0 : int(o, "pegOffsetTicks", "Offset", ALGO_LIMITS.chase.offsetTicks, e),
        chaseTicks: o.chaseTicks === void 0 ? 2 : int(o, "chaseTicks", "Re-price distance", ALGO_LIMITS.chase.chaseTicks, e),
        postOnly: bool(o, "postOnly", true),
        refillMs: o.refillMs === void 0 ? 0 : int(o, "refillMs", "Refill delay", ALGO_LIMITS.iceberg.refillMs, e),
        refillJitter: o.refillJitter === void 0 ? 0 : num2(o, "refillJitter", "Refill randomisation", { min: 0, max: 1 }, e)
      };
      break;
    }
    case "chase": {
      const L = ALGO_LIMITS.chase;
      spec = {
        ...b,
        kind,
        quantity: qty(o, "quantity", "Size", e),
        offsetTicks: o.offsetTicks === void 0 ? 0 : int(o, "offsetTicks", "Offset", L.offsetTicks, e),
        offsetBps: opt(o, "offsetBps", "Offset", L.offsetBps, e),
        chaseTicks: o.chaseTicks === void 0 ? 1 : int(o, "chaseTicks", "Re-price distance", L.chaseTicks, e),
        maxChaseBps: opt(o, "maxChaseBps", "Max chase", L.maxChaseBps, e),
        timeoutMs: opt(o, "timeoutMs", "Time limit", L.timeoutMs, e),
        onEnd: oneOf(o, "onEnd", "At the end", ["take", "cancel", "rest"], "take", e),
        minRepriceMs: o.minRepriceMs === void 0 ? 1e3 : int(o, "minRepriceMs", "Re-price pause", L.minRepriceMs, e)
      };
      break;
    }
    case "scale": {
      const L = ALGO_LIMITS.scale;
      const from = price(o, "from", "First price", e);
      const to = price(o, "to", "Last price", e);
      if (from === to) e.to = "The last price must differ from the first.";
      spec = {
        ...b,
        kind,
        quantity: qty(o, "quantity", "Size", e),
        from,
        to,
        orders: int(o, "orders", "Orders", L.orders, e),
        distribution: oneOf(o, "distribution", "Size curve", ["flat", "linear", "exponential", "bell"], "flat", e),
        skew: o.skew === void 0 ? 1 : num2(o, "skew", "Size skew", L.skew, e),
        spacing: oneOf(o, "spacing", "Price spacing", ["linear", "geometric", "front", "back"], "linear", e),
        sizeJitter: o.sizeJitter === void 0 ? 0 : num2(o, "sizeJitter", "Size randomisation", L.sizeJitter, e),
        postOnly: bool(o, "postOnly")
      };
      break;
    }
    case "dca": {
      const L = ALGO_LIMITS.dca;
      const perOrderUsd = num2(o, "perOrderUsd", "Amount per order", L.perOrderUsd, e);
      const maxTotalUsd = opt(o, "maxTotalUsd", "Total budget", { min: 10, max: 1e9 }, e);
      if (maxTotalUsd !== null && maxTotalUsd < perOrderUsd) e.maxTotalUsd = "The budget must cover at least one order.";
      spec = {
        ...b,
        kind,
        perOrderUsd,
        orders: int(o, "orders", "Orders", L.orders, e),
        intervalMs: int(o, "intervalMs", "Every", L.intervalMs, e),
        outOfBand: oneOf(o, "outOfBand", "Outside the limit", ["skip", "wait"], "skip", e),
        dipPct: opt(o, "dipPct", "Dip", L.dipPct, e),
        dipMultiplier: o.dipMultiplier === void 0 ? 1 : num2(o, "dipMultiplier", "Dip multiplier", L.dipMultiplier, e),
        maxTotalUsd,
        exec: exec(o.exec ?? { style: "taker" }, e, "exec")
      };
      break;
    }
    case "swarm": {
      const L = ALGO_LIMITS.swarm;
      spec = {
        ...b,
        kind,
        quantity: qty(o, "quantity", "Size", e),
        clips: int(o, "clips", "Clips", L.clips, e),
        inFlight: int(o, "inFlight", "Clips per wave", L.inFlight, e),
        waveMs: int(o, "waveMs", "Between waves", L.waveMs, e),
        sizeJitter: o.sizeJitter === void 0 ? 0 : num2(o, "sizeJitter", "Irregular clips", L.sizeJitter, e),
        slippageBps: num2(o, "slippageBps", "Max slippage", ALGO_LIMITS.exec.slippageBps, e),
        retries: o.retries === void 0 ? 2 : int(o, "retries", "Retries", L.retries, e)
      };
      break;
    }
    case "conditional": {
      const L = ALGO_LIMITS.conditional;
      const list = Array.isArray(o.conditions) ? o.conditions : [];
      if (list.length < L.conditions.min || list.length > L.conditions.max) e.conditions = `Add 1 to ${L.conditions.max} conditions.`;
      const conditions = list.slice(0, L.conditions.max).map((c, i) => condition(c, e, `conditions.${i}`)).filter((c) => c !== null);
      spec = {
        ...b,
        kind,
        match: oneOf(o, "match", "Match", ["all", "any"], "all", e),
        conditions,
        holdMs: o.holdMs === void 0 ? 0 : int(o, "holdMs", "Hold for", L.holdMs, e),
        expiresAt: time(o, "expiresAt", "Expiry", e),
        then: action(o.then, e, depth)
      };
      if (b.exits && (spec.then.type === "close" || spec.then.type === "algo")) e.exits = spec.then.type === "close" ? "A close opens nothing to protect: no exits on it." : "Set the exits on the algo it starts.";
      break;
    }
    case "trailing": {
      const L = ALGO_LIMITS.trailing;
      const trailPct = opt(o, "trailPct", "Trail", L.trailPct, e);
      const trailAbs = optPrice(o, "trailAbs", "Trail", e);
      if (trailPct === null === (trailAbs === null)) e.trailPct = "Set the trail as a percentage or as a price distance (one of the two).";
      spec = {
        ...b,
        kind,
        quantity: optQty(o, "quantity", "Size", e),
        trailPct,
        trailAbs,
        activationPrice: optPrice(o, "activationPrice", "Activation price", e),
        source: oneOf(o, "source", "Price", ["mark", "last"], "mark", e),
        exit: oneOf(o, "exit", "Exit", ["market", "chase"], "market", e),
        chaseMs: o.chaseMs === void 0 ? 15e3 : int(o, "chaseMs", "Chase for", L.chaseMs, e),
        slippageBps: o.slippageBps === void 0 ? 50 : num2(o, "slippageBps", "Max slippage", ALGO_LIMITS.exec.slippageBps, e)
      };
      if (spec.quantity === null) spec.reduceOnly = true;
      break;
    }
    case "basket": {
      const L = ALGO_LIMITS.basket;
      const raw = Array.isArray(o.legs) ? o.legs : [];
      if (raw.length < L.legs.min || raw.length > L.legs.max) e.legs = `A basket has ${L.legs.min} to ${L.legs.max} markets.`;
      const legs = raw.slice(0, L.legs.max).map((x, i) => {
        const v = isObj(x) ? x : {};
        return {
          symbol: symbol(v, "symbol", e, `legs.${i}.symbol`),
          side: oneOf(v, "side", "Side", ["buy", "sell"], "buy", e, `legs.${i}.side`),
          usd: num2(v, "usd", "Amount", L.legUsd, e, `legs.${i}.usd`)
        };
      });
      if (new Set(legs.map((l) => l.symbol)).size !== legs.length) e.legs = "Each market once in a basket.";
      if (b.exits) e.exits = "Exits are set per market: not on a basket.";
      const style = oneOf(o, "style", "Each leg", ["swarm", "twap"], "swarm", e);
      const durationMs = style === "twap" ? int(o, "durationMs", "Duration", ALGO_LIMITS.twap.durationMs, e) : 0;
      const slices = style === "twap" ? int(o, "slices", "Slices", ALGO_LIMITS.twap.slices, e) : 0;
      if (style === "twap" && durationMs / slices < ALGO_LIMITS.twap.minIntervalMs) e.slices = `At most one slice every ${ALGO_LIMITS.twap.minIntervalMs / 1e3} s.`;
      spec = {
        ...b,
        kind,
        symbol: legs[0]?.symbol ?? b.symbol,
        side: legs[0]?.side ?? b.side,
        legs,
        style,
        durationMs,
        slices,
        clips: style === "swarm" ? int(o, "clips", "Clips", ALGO_LIMITS.swarm.clips, e) : 0,
        inFlight: style === "swarm" ? int(o, "inFlight", "Clips per wave", ALGO_LIMITS.swarm.inFlight, e) : 0,
        waveMs: style === "swarm" ? int(o, "waveMs", "Between waves", ALGO_LIMITS.swarm.waveMs, e) : 0,
        slippageBps: num2(o, "slippageBps", "Max slippage", ALGO_LIMITS.exec.slippageBps, e)
      };
      break;
    }
    case "bracket": {
      const entry = oneOf(o, "entry", "Entry", ["market", "limit"], "market", e);
      if (!b.exits) e.exits = "A bracket needs a take-profit, a stop-loss, or both.";
      spec = {
        ...b,
        kind,
        quantity: qty(o, "quantity", "Size", e),
        entry,
        price: entry === "limit" ? price(o, "price", "Entry price", e) : null,
        slippageBps: o.slippageBps === void 0 ? 30 : num2(o, "slippageBps", "Max slippage", ALGO_LIMITS.exec.slippageBps, e)
      };
      break;
    }
  }
  return { spec: Object.keys(e).length ? null : spec, errors: e };
}
var opensPosition = (s) => !s.reduceOnly && s.kind !== "trailing" && s.kind !== "basket" && !(s.kind === "conditional" && (s.then.type === "close" || s.then.type === "algo"));
function parseAlgoSpec(input) {
  const r = checkAlgoSpec(input);
  if (!r.spec) {
    const first = Object.values(r.errors)[0] ?? "The order is not valid.";
    throw new AlgoSpecError(first, r.errors);
  }
  return r.spec;
}
function algoQuantity(s) {
  switch (s.kind) {
    case "dca":
    case "basket":
      return null;
    case "twap":
      return s.closeShare !== null ? null : Number(s.quantity);
    case "trailing":
      return s.quantity === null ? null : Number(s.quantity);
    case "conditional":
      return s.then.type === "market" || s.then.type === "limit" ? Number(s.then.quantity) : null;
    default:
      return Number(s.quantity);
  }
}
function algoSymbols(s) {
  const out = /* @__PURE__ */ new Set([s.symbol]);
  if (s.kind === "conditional") {
    for (const c of s.conditions) {
      if (c.type === "time") continue;
      out.add(c.symbol);
      if (c.type === "ratio") out.add(c.other);
    }
    if (s.then.type === "algo") for (const x of algoSymbols(s.then.algo)) out.add(x);
  }
  if (s.kind === "basket") for (const l of s.legs) out.add(l.symbol);
  return [...out];
}
var ALGO_NAMES = {
  twap: "TWAP",
  vwap: "VWAP",
  pov: "POV",
  iceberg: "Iceberg",
  chase: "Chase",
  scale: "Scale",
  dca: "DCA",
  swarm: "Swarm",
  conditional: "Conditional",
  trailing: "Trailing stop",
  basket: "Basket",
  bracket: "Bracket"
};

// packages/copy-engine/src/algo/plan.ts
function exitLevels(side, x, avg) {
  const sign2 = side === "buy" ? 1 : -1;
  return {
    tp: x.tpPrice ?? (x.tpPct !== null ? avg * (1 + sign2 * x.tpPct) : null),
    sl: x.slPrice ?? (x.slPct !== null ? avg * (1 - sign2 * x.slPct) : null)
  };
}
function twapSchedule(s, start, seed) {
  const rand = makeRng(seed);
  const weights = curveWeights(s.slices, s.urgency, s.sizeJitter, rand);
  const times = sliceTimes(start, s.durationMs, s.slices, s.timeJitter, rand);
  return { times, weights };
}
function vwapSchedule(s, start, seed, profile) {
  const rand = makeRng(seed);
  const base2 = profile && profile.weights.length === s.slices ? profile.weights : new Array(s.slices).fill(1 / s.slices);
  const weights = normalise(base2.map((w) => s.sizeJitter > 0 ? w * (1 + (rand() * 2 - 1) * s.sizeJitter) : w));
  const times = sliceTimes(start, s.durationMs, s.slices, 0, rand);
  return { times, weights };
}
function swarmClips(s, m, seed) {
  const rand = makeRng(seed);
  const w = new Array(s.clips).fill(1).map((x) => s.sizeJitter > 0 ? x * (1 + (rand() * 2 - 1) * s.sizeJitter) : x);
  return allocateSteps(Number(s.quantity), w, Number(m.stepSize)).filter((q) => q > 0);
}
function scaleLadder(s, m, seed) {
  const prices = ladderPrices(s.from, s.to, s.orders, s.spacing, m.tickSize);
  const w = ladderWeights(prices.length, s.distribution, s.skew, s.sizeJitter, makeRng(seed));
  const sizes = allocateSteps(Number(s.quantity), w, Number(m.stepSize));
  return prices.map((price2, i) => ({ price: price2, qty: sizes[i] ?? 0 }));
}

// packages/copy-engine/src/algo/feed.ts
var QUOTE_MAX_AGE_MS = 15e3;
var HISTORY_MS = 60 * 6e4;
var toNum = (v) => {
  const n = typeof v === "string" ? Number(v) : typeof v === "number" ? v : NaN;
  return Number.isFinite(n) ? n : null;
};
var rows = (d) => Array.isArray(d) ? d : d && typeof d === "object" ? [d] : [];
var AlgoFeed = class {
  constructor(o) {
    this.o = o;
    const origin = o.wsOrigin ?? GATEWAY_WS_ORIGIN[o.network];
    this.socket = new LiveSocket({
      url: `${origin}/ws/perps`,
      factory: o.factory,
      ping: '{"op":"ping"}',
      name: "sodex-algo",
      log: o.log,
      subscribe: (send, fresh) => this.subscribeAll(send, fresh),
      onMessage: (m) => this.handle(m),
      onState: (up) => {
        for (const cb of this.stateCbs) cb(up);
      }
    });
  }
  o;
  socket;
  symbols = /* @__PURE__ */ new Set();
  owners = /* @__PURE__ */ new Set();
  subscribed = { symbols: /* @__PURE__ */ new Set(), owners: /* @__PURE__ */ new Set(), marks: false };
  quotes = /* @__PURE__ */ new Map();
  lasts = /* @__PURE__ */ new Map();
  marks = /* @__PURE__ */ new Map();
  history = /* @__PURE__ */ new Map();
  tape = /* @__PURE__ */ new Map();
  seen = /* @__PURE__ */ new Set();
  seenOrder = [];
  printCbs = [];
  orderCbs = [];
  stateCbs = [];
  sampler = null;
  start() {
    this.socket.start();
    this.sampler ??= timers.every(1e3, () => this.sample());
  }
  stop() {
    this.socket.stop();
    timers.cancel(this.sampler);
    this.sampler = null;
  }
  get up() {
    return this.socket.up;
  }
  watch(symbols, owners) {
    const s = new Set(symbols.map((x) => x.toUpperCase()));
    const w = new Set(owners.map((x) => x.toLowerCase()));
    const grew = [...s].some((x) => !this.subscribed.symbols.has(x)) || [...w].some((x) => !this.subscribed.owners.has(x));
    this.symbols = s;
    this.owners = w;
    if (grew) this.socket.resubscribe();
  }
  subscribeAll(send, fresh) {
    if (fresh) {
      this.subscribed = { symbols: /* @__PURE__ */ new Set(), owners: /* @__PURE__ */ new Set(), marks: false };
    }
    let id = 500;
    if (!this.subscribed.marks) {
      send({ op: "subscribe", id: id++, params: { channel: "allMarkPrice" } });
      this.subscribed.marks = true;
    }
    const add = [...this.symbols].filter((s) => !this.subscribed.symbols.has(s));
    for (let i = 0; i < add.length; i += 40) {
      const chunk = add.slice(i, i + 40);
      send({ op: "subscribe", id: id++, params: { channel: "bookTicker", symbols: chunk } });
      send({ op: "subscribe", id: id++, params: { channel: "trade", symbols: chunk } });
      for (const s of chunk) this.subscribed.symbols.add(s);
    }
    for (const w of this.owners) {
      if (this.subscribed.owners.has(w)) continue;
      send({ op: "subscribe", id: id++, params: { channel: "accountOrderUpdate", user: w } });
      this.subscribed.owners.add(w);
    }
  }
  dedupe(id) {
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.seenOrder.push(id);
    if (this.seenOrder.length > 2e4) for (const x of this.seenOrder.splice(0, 5e3)) this.seen.delete(x);
    return true;
  }
  /** Feed one gateway message (also how tests drive it). */
  handle(m) {
    const msg = m;
    const ch = msg?.channel;
    if (!ch) return;
    const now = Date.now();
    if (ch === "bookTicker") {
      for (const r of rows(msg.data)) {
        const s = typeof r.s === "string" ? r.s.toUpperCase() : null;
        const bid = toNum(r.b);
        const ask = toNum(r.a);
        if (s && bid !== null && ask !== null && bid > 0 && ask > 0 && ask >= bid) this.quotes.set(s, { bid, ask, at: now });
      }
      return;
    }
    if (ch === "allMarkPrice" || ch === "markPrice") {
      for (const r of rows(msg.data)) {
        const s = typeof r.s === "string" ? r.s.toUpperCase() : null;
        const p = toNum(r.p);
        if (!s || p === null || !(p > 0)) continue;
        const prev = this.marks.get(s);
        this.marks.set(s, {
          mark: p,
          index: toNum(r.i) ?? prev?.index ?? null,
          funding: toNum(r.r) ?? prev?.funding ?? null,
          oi: toNum(r.oi) ?? prev?.oi ?? null,
          at: now
        });
      }
      return;
    }
    if (ch === "trade") {
      for (const r of rows(msg.data)) {
        const s = typeof r.s === "string" ? r.s.toUpperCase() : null;
        const price2 = toNum(r.p);
        const qty2 = toNum(r.q);
        if (!s || price2 === null || qty2 === null || !(price2 > 0) || !(qty2 > 0)) continue;
        if (!this.dedupe(`t:${s}:${String(r.t ?? `${r.T}:${r.p}:${r.q}`)}`)) continue;
        const at = toNum(r.T) ?? now;
        this.lasts.set(s, { price: price2, at });
        let list = this.tape.get(s);
        if (!list) this.tape.set(s, list = []);
        list.push({ t: at, q: qty2, usd: qty2 * price2 });
        if (list.length > 5e4 || list[0] && list[0].t < at - HISTORY_MS) {
          const cut = list.findIndex((x) => x.t >= at - HISTORY_MS);
          list.splice(0, cut < 0 ? list.length : cut);
        }
        const p = {
          symbol: s,
          price: price2,
          qty: qty2,
          buyer: typeof r.bi === "number" ? r.bi : -1,
          seller: typeof r.si === "number" ? r.si : -1,
          taker: r.S === "SELL" ? "sell" : "buy",
          at
        };
        for (const cb of this.printCbs) cb(p);
      }
      return;
    }
    if (ch === "accountOrderUpdate") {
      for (const r of rows(msg.data)) {
        const c = typeof r.c === "string" ? r.c : null;
        if (!c) continue;
        const u = {
          clOrdID: c,
          orderId: r.i === void 0 || r.i === null ? null : String(r.i),
          symbol: typeof r.s === "string" ? r.s.toUpperCase() : "",
          status: String(r.X ?? r.x ?? "").toUpperCase(),
          filledQty: toNum(r.z) ?? 0,
          filledValue: toNum(r.v) ?? 0,
          maker: typeof r.m === "boolean" ? r.m : null,
          reason: typeof r.r === "string" ? r.r : null,
          at: toNum(r.E) ?? now
        };
        for (const cb of this.orderCbs) cb(u);
      }
    }
  }
  sample(now = Date.now()) {
    for (const s of this.symbols) {
      const q = this.quote(s);
      const m = this.marks.get(s);
      const l = this.lasts.get(s);
      let list = this.history.get(s);
      if (!list) this.history.set(s, list = []);
      list.push({ t: now, mark: m?.mark ?? null, mid: q ? (q.bid + q.ask) / 2 : null, last: l?.price ?? null, index: m?.index ?? null, oi: m?.oi ?? null });
      if (list.length > 3700) list.splice(0, list.length - 3600);
    }
  }
  quote(symbol2) {
    const q = this.quotes.get(symbol2.toUpperCase());
    return q && Date.now() - q.at <= QUOTE_MAX_AGE_MS ? q : null;
  }
  last(symbol2) {
    return this.lasts.get(symbol2.toUpperCase()) ?? null;
  }
  mark(symbol2) {
    const m = this.marks.get(symbol2.toUpperCase());
    return m && Date.now() - m.at <= 12e4 ? m : null;
  }
  price(symbol2, source) {
    if (source === "mid") {
      const q = this.quote(symbol2);
      return q ? (q.bid + q.ask) / 2 : null;
    }
    if (source === "last") return this.last(symbol2)?.price ?? null;
    const m = this.mark(symbol2);
    return source === "index" ? m?.index ?? null : m?.mark ?? null;
  }
  sampleAgo(symbol2, agoMs) {
    const list = this.history.get(symbol2.toUpperCase());
    if (!list?.length) return null;
    const want = Date.now() - agoMs;
    if (list[0].t > want + 2e3) return null;
    let best = list[0];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].t <= want) {
        best = list[i];
        break;
      }
    }
    return best;
  }
  priceAgo(symbol2, source, agoMs) {
    const s = this.sampleAgo(symbol2, agoMs);
    if (!s) return null;
    return source === "mid" ? s.mid : source === "last" ? s.last : source === "index" ? s.index : s.mark;
  }
  oiAgo(symbol2, agoMs) {
    return this.sampleAgo(symbol2, agoMs)?.oi ?? null;
  }
  volume(symbol2, windowMs) {
    const list = this.tape.get(symbol2.toUpperCase());
    if (!list) return { qty: 0, usd: 0 };
    const from = Date.now() - windowMs;
    let qty2 = 0;
    let usd = 0;
    for (let i = list.length - 1; i >= 0 && list[i].t >= from; i--) {
      qty2 += list[i].q;
      usd += list[i].usd;
    }
    return { qty: qty2, usd };
  }
  onPrint(cb) {
    this.printCbs.push(cb);
  }
  onOrder(cb) {
    this.orderCbs.push(cb);
  }
  onState(cb) {
    this.stateCbs.push(cb);
  }
};

// packages/copy-engine/src/algo/sink.ts
var TIF = { ioc: TimeInForce.IOC, gtx: TimeInForce.GTX, gtc: TimeInForce.GTC };
function stopsAction(accountId, market, stops, builder) {
  return perpsActions.newOrder(
    accountId,
    market.id,
    stops.map((s) => ({
      clOrdID: s.clOrdID,
      modifier: OrderModifier.STOP,
      side: s.side === "buy" ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.MARKET,
      timeInForce: TimeInForce.IOC,
      quantity: s.quantity,
      stopPrice: s.triggerPrice,
      stopType: s.kind === "tp" ? StopType.TAKE_PROFIT : StopType.STOP_LOSS,
      triggerType: TriggerType.MARK_PRICE,
      reduceOnly: true
    })),
    builder ?? void 0
  );
}
var readStops = (data, stops) => readBatch(
  data,
  stops.map((s) => ({ clOrdID: s.clOrdID, side: s.side, price: s.triggerPrice, quantity: s.quantity, tif: "ioc", reduceOnly: true }))
);
function childrenAction(accountId, market, orders, builder) {
  return perpsActions.newOrder(
    accountId,
    market.id,
    orders.map((o) => ({
      clOrdID: o.clOrdID,
      modifier: OrderModifier.NORMAL,
      side: o.side === "buy" ? OrderSide.BUY : OrderSide.SELL,
      type: OrderType.LIMIT,
      timeInForce: TIF[o.tif],
      price: o.price,
      quantity: o.quantity,
      reduceOnly: o.reduceOnly
    })),
    builder ?? void 0
  );
}
var describe2 = (e) => e instanceof SodexApiError ? `${e.message}${e.hint ? ` (${e.hint})` : ""}` : e instanceof Error ? e.message : String(e);
function readBatch(data, orders) {
  const list = Array.isArray(data) ? data : unwrapList(data, "orders");
  const failed = new Set(failedOrders(list).map((r) => r.clOrdID));
  return orders.map((o) => {
    const row = list.find((r) => r.clOrdID === o.clOrdID);
    const bad = failed.has(o.clOrdID);
    return {
      clOrdID: o.clOrdID,
      ok: !bad,
      orderId: row?.orderID !== void 0 ? String(row.orderID) : null,
      error: bad ? row?.error || `code ${row?.code}` : null,
      outcomeUnknown: false
    };
  });
}
var KeyAlgoSink = class {
  constructor(client, key2, nonces, chainId, builder) {
    this.client = client;
    this.key = key2;
    this.nonces = nonces;
    this.chainId = chainId;
    this.builder = builder;
  }
  client;
  key;
  nonces;
  chainId;
  builder;
  paper = false;
  async signAndSend(action2) {
    const key2 = this.key();
    if (!key2) throw new SodexApiError(401, "no trading key is available for this algo", 401, "");
    const req = await signAndBuildWithNonceManager(action2, key2, { chainId: this.chainId, nonces: this.nonces, base: "" });
    return this.client.send(req);
  }
  async place(a, market, orders) {
    if (!orders.length) return [];
    try {
      const builder = await this.builder(a).catch(() => null);
      return readBatch(await this.signAndSend(childrenAction(a.accountId, market, orders, builder)), orders);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return orders.map((o) => ({ clOrdID: o.clOrdID, ok: false, orderId: null, error: describe2(e), outcomeUnknown: unknown }));
    }
  }
  async placeStops(a, market, stops) {
    if (!stops.length) return [];
    try {
      const builder = await this.builder(a).catch(() => null);
      return readStops(await this.signAndSend(stopsAction(a.accountId, market, stops, builder)), stops);
    } catch (e) {
      const unknown = e instanceof OutcomeUnknownError;
      return stops.map((s) => ({ clOrdID: s.clOrdID, ok: false, orderId: null, error: describe2(e), outcomeUnknown: unknown }));
    }
  }
  async cancel(a, market, clOrdIDs) {
    if (!clOrdIDs.length) return;
    try {
      await this.signAndSend(perpsActions.cancelOrder(a.accountId, clOrdIDs.map((clOrdID) => ({ symbolID: market.id, clOrdID }))));
    } catch (e) {
      if (e instanceof SodexApiError && /not found|unknown order|does not exist|already/i.test(e.message)) return;
      throw e;
    }
  }
  async setLeverage(a, market, leverage, margin) {
    await this.signAndSend(leverageAction(a.accountId, market, leverage, margin));
  }
};

// packages/copy-engine/src/algo/runtime.ts
var ALGO_TICK_MS = 500;
var FLUSH_MS = 2e3;
var MARKETS_REFRESH_MS2 = 10 * 6e4;
var STOP_DRAIN_MS = 8e3;
var STALE_IOC_MS = 8e3;
var SENDING_MAX_MS = 2e4;
var HISTORY_EVERY_MS = 2e4;
var DONE_KEPT = 60;
var MAX_CONSEC_REJECTS = 25;
var PROBLEM_RECHECK_MS = 6e4;
var LATE_MS = 3e4;
var TAKER_RETRY_MS = 1e3;
var POSITIONS_MS = 5e3;
var ACCOUNT_MS = 1e4;
var EXITS_RESIZE_MS = 5e3;
var LIVE = /* @__PURE__ */ new Set(["sending", "open", "unknown"]);
var FINAL_ORDER = /^(FILLED|CANCELED|CANCELLED|REJECTED|EXPIRED|REPLACED)$/;
var dec3 = (n) => canonicalDecimal(numberToPlainString(Number(n.toPrecision(12))));
var AlgoRuntime = class {
  constructor(host2) {
    this.host = host2;
    if (host2.market) this.market = host2.market;
    else {
      if (!host2.factory) throw new Error("an algo runtime needs a market feed or a WebSocket factory");
      this.market = new AlgoFeed({ network: host2.network, factory: host2.factory, log: host2.log });
    }
    this.market.onOrder((u) => this.onOrderUpdate(u));
    this.market.onPrint((p) => this.onPrint(p));
  }
  host;
  markets = new MarketBook();
  market;
  algos = /* @__PURE__ */ new Map();
  byClOrd = /* @__PURE__ */ new Map();
  busy = /* @__PURE__ */ new Set();
  dirty = /* @__PURE__ */ new Set();
  leverageSet = /* @__PURE__ */ new Set();
  problems = /* @__PURE__ */ new Map();
  lastHistoryAt = 0;
  lookupBusy = false;
  /** Algos that raised a hold in the step now running (steps of one algo never overlap). */
  heldNow = /* @__PURE__ */ new Set();
  eventSeq = 0;
  /** Each owner's positions and account, read at most every few seconds (conditions, closes, the leverage ceiling). */
  positionsOf = /* @__PURE__ */ new Map();
  accounts = /* @__PURE__ */ new Map();
  /** Algos whose exits are being placed or resized right now. */
  exitsBusy = /* @__PURE__ */ new Set();
  paper = /* @__PURE__ */ new Map();
  timers = [];
  running = false;
  /* ------------------------------------------------------------ lifecycle ----- */
  async start() {
    if (this.running) return;
    this.running = true;
    await this.loadMarkets();
    for (const a of await this.host.store.algos()) {
      this.algos.set(a.id, a);
      for (const x of a.exitOrders ?? []) {
        this.byClOrd.set(x.clOrdID, a.id);
        if (x.state === "sending") x.state = "unknown";
      }
      if (FINAL_STATUSES.has(a.status)) continue;
      for (const c of a.children) {
        this.byClOrd.set(c.clOrdID, a.id);
        if (LIVE.has(c.state) && !a.spec.paper) c.state = "unknown";
        if (a.spec.paper && LIVE.has(c.state)) {
          if (c.tif !== "ioc" && !c.cancelling) {
            c.state = "open";
            this.paper.set(c.clOrdID, { algoId: a.id, clOrdID: c.clOrdID, symbol: a.spec.symbol, side: c.side, price: c.price, left: Math.max(0, c.quantity - c.filled), filled: c.filled, value: c.value });
          } else {
            c.state = "done";
            c.cancelling = false;
          }
        }
      }
    }
    this.market.start();
    this.syncWatch();
    if (this.host.autoTick !== false) {
      this.timers.push(
        timers.every(ALGO_TICK_MS, () => this.tick()),
        timers.every(FLUSH_MS, () => void this.flush()),
        timers.every(MARKETS_REFRESH_MS2, () => void this.loadMarkets())
      );
    }
  }
  async stop() {
    this.running = false;
    for (const t of this.timers) timers.cancel(t);
    this.timers = [];
    for (let i = 0; this.busy.size && i < STOP_DRAIN_MS / 25; i++) await new Promise((r) => timers.after(25, () => r(void 0)));
    this.market.stop();
    await this.flush();
  }
  async loadMarkets() {
    try {
      const list = await this.host.sodex.markets();
      if (list.length) this.markets.load(list);
    } catch (e) {
      this.host.log.warn("algo: market list failed", { error: String(e) });
    }
  }
  /** Subscribe the markets and wallets the live algos need. */
  syncWatch() {
    const symbols = /* @__PURE__ */ new Set();
    const owners = /* @__PURE__ */ new Set();
    for (const a of this.algos.values()) {
      const exits2 = this.liveExits(a).length > 0;
      if (FINAL_STATUSES.has(a.status) && !exits2) continue;
      for (const s of algoSymbols(a.spec)) symbols.add(s);
      if (!a.spec.paper) owners.add(a.owner);
    }
    this.market.watch([...symbols], [...owners]);
  }
  /** Exits still on SoDEX (or on the paper book), not yet settled. */
  liveExits(a) {
    return (a.exitOrders ?? []).filter((x) => LIVE.has(x.state));
  }
  /* ------------------------------------------------------------- the API ----- */
  get(id) {
    return this.algos.get(id) ?? null;
  }
  list(owner) {
    const o = owner?.toLowerCase();
    return [...this.algos.values()].filter((a) => !o || a.owner === o).sort((x, y) => y.createdAt - x.createdAt);
  }
  /** Start an algo. The spec is validated here as everywhere (parseAlgoSpec); its market must be listed. */
  async add(n) {
    const spec = parseAlgoSpec(n.spec);
    if (!this.markets.size) await this.loadMarkets();
    for (const sym of algoSymbols(spec)) {
      const m2 = this.markets.get(sym);
      if (!m2) throw new Error(`${sym} is not listed on SoDEX perps.`);
    }
    const m = this.markets.get(spec.symbol);
    if (m.status !== "TRADING") throw new Error(`SoDEX is not trading ${m.name} right now.`);
    const now = Date.now();
    const a = {
      id: n.id ?? randomId("a"),
      owner: n.owner.toLowerCase(),
      accountId: n.accountId,
      mode: n.mode,
      spec,
      status: "scheduled",
      statusReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      endedAt: null,
      parentId: n.parentId ?? null,
      consent: n.consent ?? null,
      seed: n.seed ?? newSeed(),
      filled: 0,
      filledValue: 0,
      makerQty: 0,
      fees: 0,
      arrival: null,
      marketQty: 0,
      marketValue: 0,
      children: [],
      childCount: 0,
      rejects: 0,
      exitOrders: [],
      country: n.country ?? null,
      observedCountry: n.observedCountry ?? null,
      k: {}
    };
    if (spec.triggerPrice !== null) {
      const mk = this.market.mark(spec.symbol)?.mark ?? null;
      if (mk !== null) a.k.triggerFrom = mk;
    }
    this.algos.set(a.id, a);
    await this.host.store.saveAlgo(a);
    this.syncWatch();
    const what = spec.kind === "basket" ? `Basket of ${spec.legs.length} markets` : `${ALGO_NAMES[spec.kind]} ${spec.side === "buy" ? "buy" : "sell"} on ${spec.symbol}`;
    await this.event(a, "status", `${what} placed${spec.paper ? " (paper: nothing is sent)" : ""}.`);
    this.host.onChange?.(a.id);
    return a;
  }
  async pause(id) {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) throw new Error("This algo has ended.");
    if (a.status === "paused") return a;
    a.k.pausedFrom = a.status;
    await this.setStatus(a, "paused", "Paused by you.");
    await this.pullResting(a);
    for (const c of this.legsOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.pause(c.id);
    return a;
  }
  async resume(id) {
    const a = this.need(id);
    if (a.status !== "paused") return a;
    const back = a.k.pausedFrom === "scheduled" ? "scheduled" : "running";
    delete a.k.pausedFrom;
    await this.setStatus(a, back, null);
    for (const c of this.legsOf(a)) if (c.status === "paused") await this.resume(c.id);
    return a;
  }
  /**
   * Cancel an algo: its resting children are cancelled on SoDEX; what filled
   * stays filled, and its exits stay on SoDEX to protect that (the log says so).
   */
  async cancel(id) {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) return a;
    for (const c of this.legsOf(a)) if (!FINAL_STATUSES.has(c.status)) await this.cancel(c.id);
    await this.end(a, "cancelled", "Cancelled by you.");
    return a;
  }
  /** A basket's legs (the algos it started). */
  legsOf(a) {
    return (a.k.legs ?? []).map((id) => this.algos.get(id)).filter((x) => !!x);
  }
  /** The kill switch: every algo of `owner` is cancelled. */
  async cancelAll(owner) {
    const out = [];
    for (const a of this.list(owner)) if (!FINAL_STATUSES.has(a.status)) out.push(await this.cancel(a.id));
    return out;
  }
  /**
   * Change a running algo where that is safe: its limit price, bounds, spread
   * guard and label any time; its size only upward of what has filled (and,
   * for a schedule, from the next slice on).
   */
  async update(id, patch) {
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) throw new Error("This algo has ended.");
    const next = { ...a.spec, ...patch };
    if (patch.quantity !== void 0) {
      if (!("quantity" in a.spec) || a.spec.kind === "trailing") throw new Error("The size of this kind of algo cannot be changed.");
      if (Number(patch.quantity) <= a.filled) throw new Error("The new size must be more than what has filled.");
    }
    const spec = parseAlgoSpec(next);
    a.spec = spec;
    await this.save(a);
    await this.event(a, "info", "Changed by you.");
    return a;
  }
  async events(id, q = {}) {
    return this.host.store.algoEvents({ algoId: id, limit: q.limit ?? 200, before: q.before });
  }
  /* ---------------------------------------------------------------- views ----- */
  view(id) {
    const a = this.algos.get(id);
    if (!a) return null;
    const s = a.spec;
    const target = this.targetOf(a);
    const avg = a.filled > 0 ? a.filledValue / a.filled : null;
    const sign2 = s.side === "buy" ? 1 : -1;
    const bps = (ref) => avg !== null && ref ? (ref - avg) / ref * 1e4 * sign2 : null;
    const marketVwap = a.marketQty > 0 ? a.marketValue / a.marketQty : null;
    let progress = target ? Math.min(1, a.filled / target) : 0;
    if (s.kind === "dca") progress = Math.min(1, (Number(a.k.done ?? 0) + Number(a.k.skipped ?? 0)) / s.orders);
    const legs = this.legsOf(a);
    if (s.kind === "basket") {
      const want = s.legs.reduce((x, l) => x + l.usd, 0);
      progress = want > 0 ? Math.min(1, legs.reduce((x, c) => x + c.filledValue, 0) / want) : 0;
    }
    if (a.status === "done") progress = 1;
    const now = Date.now();
    let nextAt = null;
    let endsAt = null;
    if (s.kind === "twap" && a.startedAt !== null) {
      const times = a.k.times ?? [];
      const i = nextSlice(times, now);
      nextAt = i >= 0 ? times[i] : null;
      endsAt = a.startedAt + s.durationMs;
    } else if (s.kind === "basket" && a.startedAt !== null && s.style === "twap") endsAt = a.startedAt + s.durationMs;
    else if (s.kind === "vwap" && a.startedAt !== null) {
      const times = a.k.times ?? [];
      const i = nextSlice(times, now);
      nextAt = i >= 0 ? times[i] : null;
      endsAt = a.startedAt + s.durationMs;
    } else if (s.kind === "dca" && a.startedAt !== null) {
      const i = Number(a.k.done ?? 0) + Number(a.k.skipped ?? 0);
      nextAt = i < s.orders ? a.startedAt + i * s.intervalMs : null;
      endsAt = a.startedAt + (s.orders - 1) * s.intervalMs;
    } else if (s.kind === "pov") endsAt = s.endAt;
    else if (s.kind === "chase" && a.startedAt !== null && s.timeoutMs) endsAt = a.startedAt + s.timeoutMs;
    else if (s.kind === "swarm") nextAt = a.k.waveAt ?? null;
    else if (s.kind === "conditional") endsAt = s.expiresAt;
    if (s.startAt && a.status === "scheduled") nextAt = s.startAt;
    const live = a.children.filter((c) => LIVE.has(c.state));
    const working = live.length ? live.length === 1 ? `${live[0].tif === "ioc" ? "Taking" : "Resting"} ${live[0].quantity - live[0].filled} at ${live[0].price}` : `${live.length} orders working` : null;
    return {
      algo: a,
      target,
      progress,
      avgPrice: avg,
      vsArrivalBps: bps(a.arrival),
      vsMarketVwapBps: bps(marketVwap),
      marketVwap,
      nextAt,
      endsAt,
      working,
      triggerPrice: s.kind === "trailing" ? a.k.stop ?? null : null,
      conditions: s.kind === "conditional" ? s.conditions.map((c, i) => ({ text: this.describeCondition(c), ok: Boolean(a.k.ok?.[i]) })) : null,
      exits: (a.exitOrders ?? []).length ? (a.exitOrders ?? []).filter((x) => LIVE.has(x.state) || x.filled > 0).map((x) => ({ kind: x.exit ?? "sl", price: x.price, quantity: x.quantity, filled: x.filled, live: LIVE.has(x.state) })) : null,
      legs: s.kind === "basket" ? legs.map((c) => ({ id: c.id, symbol: c.spec.symbol, side: c.spec.side, status: c.status, filledValue: c.filledValue, avgPrice: c.filled > 0 ? c.filledValue / c.filled : null })) : null
    };
  }
  /** The base quantity the algo is to fill, as far as it is known. */
  targetOf(a) {
    const s = a.spec;
    if (s.kind === "dca") return typeof a.k.targetQty === "number" && a.k.targetQty > 0 ? a.k.targetQty : null;
    if (s.kind === "trailing" || s.kind === "conditional") return typeof a.k.takeQty === "number" ? a.k.takeQty : algoQuantity(s);
    if (s.kind === "twap" && s.closeShare !== null) return typeof a.k.total === "number" ? a.k.total : null;
    return algoQuantity(s);
  }
  /* ---------------------------------------------------------------- ticks ----- */
  /** One step for every live algo (the timer calls this; tests call it directly). */
  tick(now = Date.now()) {
    this.checkPaperExits();
    for (const a of this.algos.values()) {
      if (FINAL_STATUSES.has(a.status) || this.busy.has(a.id)) continue;
      this.busy.add(a.id);
      void this.step(a, now).catch(async (e) => {
        this.host.log.error("algo: a step failed", { algo: a.id, error: String(e) });
        await this.event(a, "error", `Step failed: ${e instanceof Error ? e.message : String(e)}`).catch(() => {
        });
      }).finally(() => this.busy.delete(a.id));
    }
  }
  /** Run one step of one algo and wait for it (tests). */
  async stepNow(id, now = Date.now()) {
    this.checkPaperExits();
    const a = this.need(id);
    if (FINAL_STATUSES.has(a.status)) return;
    while (this.busy.has(id)) await new Promise((r) => timers.after(5, () => r(void 0)));
    this.busy.add(id);
    try {
      await this.step(a, now);
    } finally {
      this.busy.delete(id);
    }
  }
  async step(a, now) {
    const s = a.spec;
    const m = this.markets.get(s.symbol);
    if (!m) {
      if (this.markets.size) await this.end(a, "failed", `${s.symbol} is no longer listed on SoDEX perps.`);
      return;
    }
    await this.settleStale(a, m, now);
    if (a.status === "paused") {
      await this.pullResting(a);
      return;
    }
    if (!s.paper) {
      const problem = await this.problemOf(a, now);
      if (problem) {
        await this.hold(a, problem);
        return;
      }
      const policy = this.host.policyFor?.(a) ?? null;
      if (policy && !policy.allowed) {
        await this.hold(a, `Held: ${policy.reason ?? "not available in your region."}`);
        return;
      }
    }
    if (m.status !== "TRADING") {
      await this.hold(a, `SoDEX is not trading ${m.name} right now.`);
      return;
    }
    const q = this.market.quote(s.symbol);
    if (!q) {
      await this.hold(a, "Waiting for a price from SoDEX.");
      return;
    }
    if (a.status === "scheduled") {
      if (!await this.ready(a, now)) return;
      await this.begin(a, m, now);
      if (FINAL_STATUSES.has(a.status)) return;
    }
    const mk = this.market.mark(s.symbol)?.mark ?? mid(q);
    const b = s.upper && mk >= s.upper.price ? { ...s.upper, which: "upper" } : s.lower && mk <= s.lower.price ? { ...s.lower, which: "lower" } : null;
    if (b) {
      const words = `the price is ${b.which === "upper" ? "at or above" : "at or below"} your ${b.which} bound of ${b.price}`;
      if (b.then === "stop" || s.kind === "scale") {
        await this.end(a, this.isDone(a, m) ? "done" : "expired", `Stopped: ${words}.`);
        return;
      }
      if (b.then === "hold") {
        await this.pullResting(a);
        await this.hold(a, `Held: ${words}.`);
        return;
      }
      if (!a.k.rush) {
        a.k.rush = true;
        await this.event(a, "info", `Taking the rest now: ${words}.`);
      }
    }
    this.heldNow.delete(a.id);
    await this.stepKind(a, m, q, mk, now);
    if (!this.heldNow.has(a.id) && !FINAL_STATUSES.has(a.status)) await this.run(a);
    if (!FINAL_STATUSES.has(a.status)) await this.syncExits(a, m, false);
  }
  async stepKind(a, m, q, mk, now) {
    const s = a.spec;
    switch (s.kind) {
      case "twap":
      case "vwap":
        return this.stepSchedule(a, m, q, mk, now);
      case "pov":
        return this.stepPov(a, m, q, mk, now);
      case "dca":
        return this.stepDca(a, m, q, mk, now);
      case "iceberg":
        return this.stepIceberg(a, m, q, now);
      case "chase":
        return this.stepChase(a, m, q, mk, now);
      case "scale":
        return this.stepScale(a, m, q, now);
      case "swarm":
        return this.stepSwarm(a, m, q, mk, now);
      case "conditional":
        return this.stepConditional(a, m, q, mk, now);
      case "trailing":
        return this.stepTrailing(a, m, q, mk, now);
      case "basket":
        return this.stepBasket(a);
      case "bracket":
        return this.stepBracket(a, m, q, mk);
    }
  }
  /** Whether a scheduled algo may begin: its start time and its start price. */
  async ready(a, now) {
    const s = a.spec;
    if (s.startAt !== null && now < s.startAt) return false;
    if (s.triggerPrice !== null) {
      const mk = this.market.mark(s.symbol)?.mark ?? null;
      if (mk === null) return false;
      if (typeof a.k.triggerFrom !== "number") {
        a.k.triggerFrom = mk;
        this.dirty.add(a.id);
      }
      const from = a.k.triggerFrom;
      const hit = from >= s.triggerPrice ? mk <= s.triggerPrice : mk >= s.triggerPrice;
      if (!hit) return false;
      await this.event(a, "info", `The mark reached your start price of ${s.triggerPrice}.`);
    }
    return true;
  }
  /** Start working: the arrival price, the schedule, the profile. */
  async begin(a, m, now) {
    const s = a.spec;
    const q = this.market.quote(s.symbol);
    a.startedAt = now;
    a.arrival = q ? mid(q) : this.market.mark(s.symbol)?.mark ?? null;
    if (s.kind === "twap") {
      if (s.closeShare !== null) {
        const pos = await this.positionOf(a, s.symbol);
        const size = pos === null ? 0 : floorStep(Math.abs(pos) * s.closeShare, m);
        if (!pos || size < Number(m.stepSize)) {
          a.startedAt = null;
          await this.end(a, "expired", pos === null ? `Your position on ${m.name} could not be read; nothing was closed.` : `There is no position on ${m.name} to close.`);
          return;
        }
        a.k.total = size;
        a.k.closeSide = pos > 0 ? "sell" : "buy";
        await this.event(a, "info", `Closing ${Math.round(s.closeShare * 100)}% of your ${pos > 0 ? "long" : "short"}: ${dec3(size)} ${m.base}.`);
      }
      const { times, weights } = twapSchedule(s, now, a.seed);
      a.k.times = times;
      a.k.weights = weights;
    } else if (s.kind === "vwap") {
      const profile = await this.profileFor(s.symbol, now, s.durationMs, s.slices, s.lookbackDays).catch((e) => {
        this.host.log.warn("algo: volume profile failed", { symbol: s.symbol, error: String(e) });
        return null;
      });
      const { times, weights } = vwapSchedule(s, now, a.seed, profile);
      a.k.times = times;
      a.k.weights = weights;
      a.k.expectedTotal = profile ? profile.expected.reduce((x, y) => x + y, 0) : 0;
      if (!profile) await this.event(a, "info", "No volume history could be read: the schedule is even (a TWAP).");
    } else if (s.kind === "chase") {
      a.k.startRef = q ? s.side === "buy" ? q.bid : q.ask : null;
    } else if (s.kind === "swarm") {
      a.k.clips = swarmClips(s, m, a.seed);
      a.k.next = 0;
      a.k.retriesLeft = s.retries;
      a.k.waveAt = now;
    }
    await this.setStatus(a, "running", null);
    await this.event(a, "status", a.arrival ? `Started. Arrival price ${a.arrival}.` : "Started.");
  }
  /* ---------------------------------------------------------- the worker ----- */
  /** Live children: sent and not settled. */
  live(a) {
    return a.children.filter((c) => LIVE.has(c.state));
  }
  /** What could still fill: everything live, in full. */
  pendingQty(a) {
    return this.live(a).reduce((x, c) => x + Math.max(0, c.quantity - c.filled), 0);
  }
  /**
   * Keep the working order in line with the plan: `due` is what should be
   * filled by now, `late` how much of it is overdue (taken at once), the rest
   * of what is due may rest as one post-only child at the touch.
   */
  async work(a, m, q, mk, o) {
    const s = a.spec;
    const side = o.side ?? s.side;
    const reduceOnly = o.reduceOnly ?? s.reduceOnly;
    const live = this.live(a);
    if (live.some((c) => c.state !== "open" || c.cancelling)) return;
    const limit = side === s.side ? s.limitPrice : null;
    const ref = side === "buy" ? q.ask : q.bid;
    const finishing = o.late >= o.total;
    const minQ = Math.max(minChildQty(m, ref), o.minChild && !finishing ? o.minChild : 0);
    const cap = o.maxChild !== void 0 && o.maxChild !== null ? o.maxChild : Infinity;
    const room = Math.max(0, o.total - a.filled);
    const need = Math.min(room, o.due - a.filled);
    const lateNeed = Math.min(need, o.late - a.filled);
    const resting = live.find((c) => c.tif !== "ioc") ?? null;
    const taking = live.find((c) => c.tif === "ioc") ?? null;
    if (taking) return;
    if (lateNeed >= minQ - 1e-12 || lateNeed > 0 && need >= room - 1e-12 && room > 0 && o.late >= o.total) {
      if (resting) {
        await this.cancelChildren(a, m, [resting]);
        return;
      }
      if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) {
        await this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
        return;
      }
      if (Date.now() - Number(a.k.missAt ?? 0) < TAKER_RETRY_MS) return;
      let qty2 = floorStep(lateNeed, m);
      if (need - qty2 < minQ) qty2 = floorStep(need, m);
      qty2 = Math.min(qty2, floorStep(cap, m));
      if (qty2 < minQ) {
        if (room < minQ && o.late >= o.total && !o.more) await this.end(a, "done", a.filled > 0 ? `Filled; ${dec3(room)} ${m.base} under SoDEX's minimum order was left.` : "Under SoDEX's minimum order size: nothing could be sent.");
        return;
      }
      const price3 = takerPrice(side, q, o.exec.slippageBps, m, mk, limit);
      if (price3 === null) {
        await this.hold(a, `Held: the price is past your limit of ${limit}.`);
        return;
      }
      await this.send(a, m, [{ side, price: price3, quantity: qty2, tif: "ioc", tag: o.tag, reduceOnly }]);
      return;
    }
    if (o.exec.style === "taker") return;
    const want = floorStep(Math.min(need, cap), m);
    const price2 = makerPrice(side, q, o.exec.offsetTicks, null, m, limit);
    if (resting) {
      const tick = Number(m.tickSize);
      const left = resting.quantity - resting.filled;
      const off = Math.abs(resting.price - price2) / tick;
      const since = Date.now() - resting.placedAt;
      const reprice = off >= o.exec.chaseTicks - 1e-9 && since >= (o.minRepriceMs ?? 1500);
      const grow = want - left >= minQ;
      const shrink = left - want > 1e-12 && want < minQ;
      if (reprice || grow || shrink) await this.cancelChildren(a, m, [resting]);
      return;
    }
    if (want < minChildQty(m, price2)) return;
    await this.send(a, m, [{ side, price: price2, quantity: want, tif: "gtx", tag: o.tag, reduceOnly }]);
  }
  /* ----------------------------------------------------------- the kinds ----- */
  async stepSchedule(a, m, q, mk, now) {
    const s = a.spec;
    const total = typeof a.k.total === "number" ? a.k.total : Number(s.quantity);
    const closeSide = a.k.closeSide;
    if (this.isDone(a, m)) return this.end(a, "done", "Filled.");
    const start = a.startedAt;
    const end = start + s.durationMs;
    const times = a.k.times ?? [];
    const weights = a.k.weights ?? [];
    const interval = s.durationMs / s.slices;
    let share = dueShare(times, weights, now);
    let lateShare = s.exec.style === "taker" ? share : s.exec.style === "hybrid" ? dueShare(times, weights, now - s.exec.makerShare * interval) : 0;
    if (s.kind === "vwap" && s.adaptive) {
      const exp = Number(a.k.expectedTotal ?? 0);
      share = adaptiveShare(share, a.marketQty, exp);
      if (s.exec.style === "taker") lateShare = share;
    }
    const finishing = now >= end || a.k.rush === true;
    if (now >= end && s.finish === "leave" && !a.k.rush) {
      if (this.live(a).length) {
        await this.pullResting(a);
        return;
      }
      return this.end(a, this.isDone(a, m) ? "done" : "expired", `Time is up; ${dec3(Math.max(0, total - a.filled))} ${m.base} left unfilled, as you chose.`);
    }
    const i = Math.max(0, nextSlice(times, now) < 0 ? times.length - 1 : nextSlice(times, now) - 1);
    const vol = s.maxParticipation !== null ? this.market.volume(s.symbol, Math.max(interval, 5e3)).qty : null;
    let maxChild = vol !== null && !finishing ? Math.max(0, vol * s.maxParticipation) : Infinity;
    if (s.kind === "twap" && s.maxSliceQty !== null) maxChild = Math.min(maxChild, Number(s.maxSliceQty));
    await this.work(a, m, q, mk, {
      due: finishing ? total : total * share,
      late: finishing ? total : total * lateShare,
      total,
      exec: s.exec,
      tag: finishing ? "finish" : `slice ${i + 1}/${times.length}`,
      maxChild: Number.isFinite(maxChild) ? maxChild : null,
      minChild: s.kind === "twap" && s.minSliceQty !== null ? Number(s.minSliceQty) : null,
      ...closeSide ? { side: closeSide, reduceOnly: true } : {}
    });
  }
  dueHistory(a, now, due) {
    const h = (a.k.hist ?? []).filter((x) => x[0] >= now - 10 * 6e4);
    if (!h.length || h[h.length - 1][1] !== due) h.push([now, due]);
    a.k.hist = h.slice(-300);
    return a.k.hist;
  }
  dueAgo(h, at) {
    let v = 0;
    for (const [t, d] of h) if (t <= at) v = d;
    return v;
  }
  async stepPov(a, m, q, mk, now) {
    const s = a.spec;
    const total = Number(s.quantity);
    if (this.isDone(a, m)) return this.end(a, "done", "Filled.");
    const ended = s.endAt !== null && now >= s.endAt;
    if (ended && s.finish === "leave" && !a.k.rush) {
      if (this.live(a).length) return this.pullResting(a);
      return this.end(a, "expired", `End time reached; ${dec3(total - a.filled)} ${m.base} left unfilled, as you chose.`);
    }
    const due = Math.min(total, s.rate * a.marketQty);
    const h = this.dueHistory(a, now, due);
    const late = s.exec.style === "taker" ? due : s.exec.style === "hybrid" ? this.dueAgo(h, now - LATE_MS) : 0;
    const finishing = ended || a.k.rush === true;
    await this.work(a, m, q, mk, {
      due: finishing ? total : due,
      late: finishing ? total : late,
      total,
      exec: s.exec,
      tag: finishing ? "finish" : `${Math.round(s.rate * 100)}% of volume`,
      maxChild: s.maxChildQty !== null ? Number(s.maxChildQty) : null
    });
  }
  async stepDca(a, m, q, mk, now) {
    const s = a.spec;
    const start = a.startedAt;
    let done = Number(a.k.done ?? 0);
    let skipped = Number(a.k.skipped ?? 0);
    let spent = Number(a.k.spentUsd ?? 0);
    let target = Number(a.k.targetQty ?? 0);
    const budget = s.maxTotalUsd ?? Infinity;
    while (done + skipped < s.orders && start + (done + skipped) * s.intervalMs <= now && spent < budget - 1e-9) {
      const px = s.side === "buy" ? q.ask : q.bid;
      const outside = s.limitPrice !== null && (s.side === "buy" ? mk > s.limitPrice : mk < s.limitPrice);
      if (outside) {
        if (s.outOfBand === "wait") {
          await this.hold(a, `Waiting: the price is ${s.side === "buy" ? "above" : "below"} your limit of ${s.limitPrice}.`);
          break;
        }
        skipped++;
        await this.event(a, "skip", `Order ${done + skipped} of ${s.orders} skipped: the price ${mk} is ${s.side === "buy" ? "above" : "below"} your limit.`);
        continue;
      }
      let usd = s.perOrderUsd;
      const avg = a.filled > 0 ? a.filledValue / a.filled : null;
      if (s.dipPct !== null && avg !== null && (s.side === "buy" ? px <= avg * (1 - s.dipPct) : px >= avg * (1 + s.dipPct))) {
        usd *= s.dipMultiplier;
        await this.event(a, "info", `Dip boost: ${s.dipMultiplier}x this order (the price is ${(Math.abs(px / avg - 1) * 100).toFixed(1)}% from your average).`);
      }
      usd = Math.min(usd, budget - spent);
      target += usd / px;
      spent += usd;
      done++;
    }
    a.k.done = done;
    a.k.skipped = skipped;
    a.k.spentUsd = spent;
    a.k.targetQty = target;
    this.dirty.add(a.id);
    const over = done + skipped >= s.orders || spent >= budget - 1e-9;
    const left = target - a.filled - this.pendingQty(a);
    if (over && left < minChildQty(m, mk) && !this.live(a).length) return this.end(a, "done", `${done} order${done === 1 ? "" : "s"} filled${skipped ? `, ${skipped} skipped` : ""}.`);
    const h = this.dueHistory(a, now, target);
    const late = s.exec.style === "taker" ? target : s.exec.style === "hybrid" ? this.dueAgo(h, now - Math.min(LATE_MS * 4, s.exec.makerShare * s.intervalMs)) : over ? target : 0;
    await this.work(a, m, q, mk, { due: target, late: a.k.rush ? target : late, total: target, exec: s.exec, tag: `order ${done}/${s.orders}`, more: !over });
  }
  async stepIceberg(a, m, q, now) {
    const s = a.spec;
    const total = Number(s.quantity);
    const live = this.live(a);
    if (!live.length && this.isDone(a, m)) return this.end(a, "done", "Filled.");
    const pegged = s.price === null;
    const tif = s.postOnly ? "gtx" : "gtc";
    const desired = pegged ? makerPrice(s.side, q, s.pegOffsetTicks, null, m, s.limitPrice) : s.price;
    if (live.length) {
      const c = live[0];
      if (c.state !== "open" || c.cancelling) return;
      if (pegged && Math.abs(c.price - desired) / Number(m.tickSize) >= s.chaseTicks - 1e-9 && now - c.placedAt >= 1e3) {
        a.k.clipLeft = Math.max(0, c.quantity - c.filled);
        await this.cancelChildren(a, m, [c]);
      }
      return;
    }
    if (a.k.rush) {
      return this.work(a, m, q, this.market.mark(s.symbol)?.mark ?? mid(q), { due: total, late: total, total, exec: { style: "taker", slippageBps: 50, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: "rush" });
    }
    if (typeof a.k.refillAt === "number" && now < a.k.refillAt) return;
    const room = total - a.filled;
    const minQ = minChildQty(m, desired);
    const refill = typeof a.k.clipLeft === "number" && a.k.clipLeft > 0;
    let qty2 = refill ? a.k.clipLeft : floorStep(jitter(Number(s.displayQty), s.displayJitter, makeRng(a.seed + a.childCount)), m);
    qty2 = Math.max(qty2, minQ);
    if (room - qty2 < minQ) qty2 = room;
    qty2 = floorStep(Math.min(qty2, room), m);
    if (qty2 < minQ) return this.end(a, "done", a.filled > 0 ? "Filled (the rest is under SoDEX's minimum order)." : "Under SoDEX's minimum order size.");
    delete a.k.clipLeft;
    if (!refill) a.k.clip = Number(a.k.clip ?? 0) + 1;
    await this.send(a, m, [{ side: s.side, price: desired, quantity: qty2, tif, tag: `clip ${a.k.clip}` }]);
  }
  async stepChase(a, m, q, mk, now) {
    const s = a.spec;
    const total = Number(s.quantity);
    const live = this.live(a);
    if (!live.length && this.isDone(a, m)) return this.end(a, "done", "Filled.");
    const timedOut = s.timeoutMs !== null && now - a.startedAt >= s.timeoutMs;
    if (timedOut || a.k.rush || a.k.ending) {
      const how = a.k.rush ? "take" : s.onEnd;
      a.k.ending = true;
      if (how === "take") return this.work(a, m, q, mk, { due: total, late: total, total, exec: { style: "taker", slippageBps: 50, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: "take the rest" });
      if (how === "rest") {
        const c = live.find((x) => x.tif !== "ioc");
        if (c) c.tag = "left resting";
        return this.end(a, "expired", c ? `Time is up: left resting at ${c.price} on SoDEX, as you chose.` : "Time is up.", { keep: c ? [c.clOrdID] : [] });
      }
      return this.end(a, "expired", `Time is up; ${dec3(total - a.filled)} ${m.base} left unfilled.`);
    }
    const startRef = typeof a.k.startRef === "number" ? a.k.startRef : s.side === "buy" ? q.bid : q.ask;
    let cap = s.limitPrice;
    if (s.maxChaseBps !== null) {
      const c = s.side === "buy" ? startRef * (1 + s.maxChaseBps / 1e4) : startRef * (1 - s.maxChaseBps / 1e4);
      cap = cap === null ? c : s.side === "buy" ? Math.min(cap, c) : Math.max(cap, c);
    }
    const price2 = makerPrice(s.side, q, s.offsetTicks, s.offsetBps, m, cap);
    const room = total - a.filled;
    if (live.length) {
      const c = live[0];
      if (c.state !== "open" || c.cancelling) return;
      const off = Math.abs(c.price - price2) / Number(m.tickSize);
      if (off >= s.chaseTicks - 1e-9 && now - c.placedAt >= s.minRepriceMs) await this.cancelChildren(a, m, [c]);
      return;
    }
    const qty2 = floorStep(room, m);
    if (qty2 < minChildQty(m, price2)) return this.end(a, "done", a.filled > 0 ? "Filled." : "Under SoDEX's minimum order size.");
    await this.send(a, m, [{ side: s.side, price: price2, quantity: qty2, tif: "gtx", tag: "chase" }]);
  }
  async stepScale(a, m, _q, _now) {
    const s = a.spec;
    if (!a.k.placed) {
      const ladder = scaleLadder(s, m, a.seed).filter((l) => l.qty >= minChildQty(m, l.price));
      if (!ladder.length) return this.end(a, "failed", "No level of this ladder reaches SoDEX's minimum order.");
      a.k.placed = true;
      a.k.levels = ladder.length;
      const tif = s.postOnly ? "gtx" : "gtc";
      for (let i = 0; i < ladder.length; i += 50) {
        const chunk = ladder.slice(i, i + 50);
        await this.send(a, m, chunk.map((l, j) => ({ side: s.side, price: l.price, quantity: l.qty, tif, tag: `level ${i + j + 1}/${ladder.length}` })));
      }
      return;
    }
    if (this.live(a).length) return;
    const total = Number(s.quantity);
    if (this.isDone(a, m)) return this.end(a, "done", "Every level filled.");
    return this.end(a, "expired", `${dec3(total - a.filled)} ${m.base} of the ladder did not fill (cancelled or refused).`);
  }
  async stepSwarm(a, m, q, mk, now) {
    const s = a.spec;
    const total = Number(s.quantity);
    if (this.live(a).length) return;
    if (this.isDone(a, m)) return this.end(a, "done", "Filled.");
    const waveAt = Number(a.k.waveAt ?? 0);
    if (now < waveAt && !a.k.rush) return;
    if (s.maxSpreadBps !== null && spreadBps(q) > s.maxSpreadBps) return this.hold(a, `Held: the spread (${spreadBps(q).toFixed(1)} bp) is wider than your ${s.maxSpreadBps} bp.`);
    const price2 = takerPrice(s.side, q, s.slippageBps, m, mk, s.limitPrice);
    if (price2 === null) return this.hold(a, `Held: the price is past your limit of ${s.limitPrice}.`);
    const clips = a.k.clips ?? [];
    let next = Number(a.k.next ?? 0);
    let pool = total - a.filled;
    const minQ = minChildQty(m, price2);
    const wave = [];
    if (next < clips.length) {
      while (wave.length < s.inFlight && next < clips.length && pool >= minQ) {
        let qty2 = Math.min(clips[next], pool);
        if (pool - qty2 < minQ) qty2 = pool;
        qty2 = floorStep(qty2, m);
        next++;
        if (qty2 < minQ) continue;
        wave.push(qty2);
        pool -= qty2;
      }
      a.k.next = next;
    } else {
      const left = Number(a.k.retriesLeft ?? 0);
      if (left <= 0 || pool < minQ) return this.end(a, "expired", `${dec3(pool)} ${m.base} did not fill after ${s.retries} retr${s.retries === 1 ? "y" : "ies"}.`);
      a.k.retriesLeft = left - 1;
      const avg = total / Math.max(1, clips.length);
      const n = Math.max(1, Math.min(s.inFlight, Math.round(pool / avg)));
      for (let i = 0; i < n && pool >= minQ; i++) {
        let qty2 = i === n - 1 ? pool : floorStep(pool / (n - i), m);
        if (pool - qty2 < minQ) qty2 = pool;
        qty2 = floorStep(qty2, m);
        if (qty2 < minQ) break;
        wave.push(qty2);
        pool -= qty2;
      }
      await this.event(a, "info", `Retrying ${dec3(total - a.filled)} ${m.base} that did not fill.`);
    }
    if (!wave.length) return;
    a.k.waveAt = now + s.waveMs;
    a.k.wave = Number(a.k.wave ?? 0) + 1;
    await this.send(a, m, wave.map((qty2) => ({ side: s.side, price: price2, quantity: qty2, tif: "ioc", tag: `wave ${a.k.wave}` })));
  }
  async stepConditional(a, m, q, mk, now) {
    const s = a.spec;
    if (a.k.fired) return this.afterFire(a, m, q, mk);
    if (s.expiresAt !== null && now >= s.expiresAt) return this.end(a, "expired", "Its time ran out before the conditions held.");
    const ok = s.conditions.map((c, i) => this.conditionHolds(a, c, i, now));
    a.k.ok = ok;
    const met = s.match === "all" ? ok.every(Boolean) : ok.some(Boolean);
    if (!met) {
      if (a.k.holdSince) delete a.k.holdSince;
      this.dirty.add(a.id);
      return;
    }
    if (typeof a.k.holdSince !== "number") a.k.holdSince = now;
    if (now - a.k.holdSince < s.holdMs) return;
    a.k.fired = now;
    const t = s.then;
    await this.event(a, "info", `Conditions held${s.holdMs ? ` for ${Math.round(s.holdMs / 1e3)} s` : ""}: acting.`);
    if (t.type === "market") a.k.takeQty = Number(t.quantity);
    else if (t.type === "close") {
      const pos = await this.positionOf(a, s.symbol);
      if (!pos) return this.end(a, "expired", `There was no position on ${s.symbol} to close.`);
      a.k.takeQty = floorStep(Math.abs(pos) * t.share, m);
      a.k.closeSide = pos > 0 ? "sell" : "buy";
    } else if (t.type === "limit") {
      await this.send(a, m, [{ side: s.side, price: t.price, quantity: Number(t.quantity), tif: t.postOnly ? "gtx" : "gtc", tag: "trigger", reduceOnly: s.reduceOnly }]);
      return this.end(a, "done", `Placed a limit ${s.side} of ${t.quantity} at ${t.price}; it rests on SoDEX.`, { keep: a.children.filter((c) => LIVE.has(c.state)).map((c) => c.clOrdID) });
    } else {
      try {
        const child = await this.add({ owner: a.owner, accountId: a.accountId, mode: a.mode, spec: t.algo, parentId: a.id, consent: a.consent });
        return this.end(a, "done", `Started a ${ALGO_NAMES[child.spec.kind]} on ${child.spec.symbol}.`);
      } catch (e) {
        return this.end(a, "failed", `Could not start the ${ALGO_NAMES[t.algo.kind]}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.dirty.add(a.id);
    return this.afterFire(a, m, q, mk);
  }
  /** A fired conditional or trailing stop: take `k.takeQty` (a chase first, for a trailing stop that asks for one). */
  async afterFire(a, m, q, mk) {
    const s = a.spec;
    const total = Number(a.k.takeQty ?? 0);
    if (!(total > 0)) return this.end(a, "expired", "Nothing to send.");
    if (!this.live(a).length && a.filled >= total - Number(m.stepSize) / 2) return this.end(a, "done", "Filled.");
    const side = a.k.closeSide ?? s.side;
    const slip = s.kind === "conditional" && (s.then.type === "market" || s.then.type === "close") ? s.then.slippageBps : s.kind === "trailing" ? s.slippageBps : 50;
    const chasing = s.kind === "trailing" && s.exit === "chase" && Date.now() - Number(a.k.fired) < s.chaseMs;
    await this.work(a, m, q, mk, {
      side,
      reduceOnly: a.k.closeSide !== void 0 ? true : void 0,
      due: total,
      late: chasing ? 0 : total,
      total,
      exec: { style: chasing ? "maker" : "taker", slippageBps: slip, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 },
      tag: s.kind === "trailing" ? "trailing stop" : "trigger",
      minRepriceMs: 1e3
    });
  }
  async stepTrailing(a, m, q, mk, now) {
    const s = a.spec;
    if (a.k.fired) return this.afterFire(a, m, q, mk);
    const price2 = s.source === "last" ? this.market.last(s.symbol)?.price ?? mk : mk;
    const st = a.k.trail ?? { armed: false, extreme: null };
    const r = trail(st, s.side, price2, s);
    const wasArmed = st.armed;
    a.k.trail = r.state;
    a.k.stop = r.stop;
    this.dirty.add(a.id);
    if (!wasArmed && r.state.armed && s.activationPrice !== null) await this.event(a, "info", `Activated at ${price2}; trailing from here.`);
    if (!r.fired) return;
    a.k.fired = now;
    if (s.quantity !== null) a.k.takeQty = Number(s.quantity);
    else {
      const pos = await this.positionOf(a, s.symbol);
      const right = pos !== null && (s.side === "sell" ? pos > 0 : pos < 0);
      if (!right) return this.end(a, "expired", `Fired at ${price2}, but there was no ${s.side === "sell" ? "long" : "short"} position on ${s.symbol} to close.`);
      a.k.takeQty = floorStep(Math.abs(pos), m);
    }
    await this.event(a, "info", `Fired: ${s.source} ${price2} reached the stop at ${r.stop?.toFixed(6).replace(/\.?0+$/, "")}.`);
    return this.afterFire(a, m, q, mk);
  }
  /**
   * A basket: each market becomes an algo of its own (a swarm or a TWAP),
   * sized from its USD at the mark when it starts, all started together; the
   * basket ends when every leg has.
   */
  async stepBasket(a) {
    const s = a.spec;
    if (!a.k.legs) {
      const specs = [];
      for (const l of s.legs) {
        const lm = this.markets.get(l.symbol);
        const lq = this.market.quote(l.symbol);
        const px = this.market.mark(l.symbol)?.mark ?? (lq ? mid(lq) : null);
        if (!lm || !px) return this.hold(a, `Waiting for a price of ${l.symbol}.`);
        const qty2 = floorStep(l.usd / px, lm);
        if (qty2 < minChildQty(lm, px)) return this.end(a, "failed", `${l.symbol}: $${l.usd} is under SoDEX's minimum order.`);
        const common = { symbol: l.symbol, side: l.side, reduceOnly: s.reduceOnly, leverage: s.leverage, marginMode: s.marginMode, paper: s.paper, maxSpreadBps: s.maxSpreadBps, label: `${s.label ?? "Basket"}: ${l.symbol}` };
        specs.push(
          s.style === "swarm" ? { ...common, kind: "swarm", quantity: dec3(qty2), clips: s.clips, inFlight: s.inFlight, waveMs: s.waveMs, sizeJitter: 0.2, slippageBps: s.slippageBps, retries: 2 } : { ...common, kind: "twap", quantity: dec3(qty2), durationMs: s.durationMs, slices: s.slices, sizeJitter: 0.15, timeJitter: 0.2, exec: { style: "taker", slippageBps: s.slippageBps }, finish: "take" }
        );
      }
      const ids = [];
      for (const [i, spec] of specs.entries()) {
        const child = await this.add({ owner: a.owner, accountId: a.accountId, mode: a.mode, spec, parentId: a.id, consent: a.consent, seed: a.seed + i + 1 >>> 0, country: a.country, observedCountry: a.observedCountry });
        ids.push(child.id);
      }
      a.k.legs = ids;
      this.dirty.add(a.id);
      await this.event(a, "info", `Started ${ids.length} legs: ${s.legs.map((l) => `${l.side} $${l.usd} ${l.symbol}`).join(", ")}.`);
      return;
    }
    const legs = this.legsOf(a);
    if (legs.length && legs.every((c) => FINAL_STATUSES.has(c.status))) {
      const short = legs.filter((c) => c.status !== "done");
      return this.end(a, short.length ? "expired" : "done", short.length ? `${short.length} of ${legs.length} markets did not fill in full (${short.map((c) => c.spec.symbol).join(", ")}).` : "Every market filled.");
    }
  }
  /** A bracket: the entry (a taker with a slippage cap, or one resting limit); its exits follow what fills. */
  async stepBracket(a, m, q, mk) {
    const s = a.spec;
    const total = Number(s.quantity);
    if (!this.live(a).length && this.isDone(a, m)) return this.end(a, "done", s.paper ? "Entered; its exits are watched on the paper book." : "Entered; its exits are on SoDEX.");
    if (s.entry === "market") {
      return this.work(a, m, q, mk, { due: total, late: total, total, exec: { style: "taker", slippageBps: s.slippageBps, offsetTicks: 0, chaseTicks: 1, makerShare: 0.5 }, tag: "entry" });
    }
    if (!a.k.placed) {
      a.k.placed = true;
      await this.send(a, m, [{ side: s.side, price: s.price, quantity: total, tif: "gtc", tag: "entry" }]);
      return;
    }
    if (this.live(a).length) return;
    return this.end(a, "expired", a.filled > 0 ? `The entry filled ${dec3(a.filled)} of ${s.quantity} and is no longer on SoDEX; its exits cover what filled.` : "The entry order is no longer on SoDEX (cancelled or refused).");
  }
  /* ---------------------------------------------------------- conditions ----- */
  conditionHolds(a, c, i, now) {
    const mk = this.market;
    switch (c.type) {
      case "time":
        return now >= c.at;
      case "price": {
        const p = mk.price(c.symbol, c.source);
        return p !== null && (c.op === "above" ? p >= c.value : p <= c.value);
      }
      case "cross": {
        const p = mk.price(c.symbol, c.source);
        if (p === null) return false;
        const key2 = `x${i}`;
        const other = c.dir === "up" ? p < c.value : p > c.value;
        if (other) {
          a.k[key2] = true;
          return false;
        }
        return a.k[key2] === true;
      }
      case "move": {
        const p = mk.price(c.symbol, c.source);
        const then = mk.priceAgo(c.symbol, c.source, c.windowMs);
        if (p === null || then === null || !(then > 0)) return false;
        const ch = p / then - 1;
        return c.dir === "up" ? ch >= c.pct : c.dir === "down" ? ch <= -c.pct : Math.abs(ch) >= c.pct;
      }
      case "funding": {
        const f = mk.mark(c.symbol)?.funding ?? null;
        return f !== null && (c.op === "above" ? f >= c.value : f <= c.value);
      }
      case "oi": {
        const now0 = mk.mark(c.symbol)?.oi ?? null;
        const then = mk.oiAgo(c.symbol, c.windowMs);
        if (now0 === null || then === null || !(then > 0)) return false;
        const ch = now0 / then - 1;
        return c.dir === "up" ? ch >= c.pct : c.dir === "down" ? ch <= -c.pct : Math.abs(ch) >= c.pct;
      }
      case "spread": {
        const q = mk.quote(c.symbol);
        if (!q) return false;
        const b = spreadBps(q);
        return c.op === "above" ? b >= c.bps : b <= c.bps;
      }
      case "volume":
        return mk.volume(c.symbol, c.windowMs).usd >= c.aboveUsd;
      case "ratio": {
        const x = mk.mark(c.symbol)?.mark ?? null;
        const y = mk.mark(c.other)?.mark ?? null;
        if (x === null || y === null || !(y > 0)) return false;
        return c.op === "above" ? x / y >= c.value : x / y <= c.value;
      }
      case "position": {
        const book = this.cachedPositions(a, now);
        if (!book) return false;
        const p = book[c.symbol] ?? { size: 0, entry: 0 };
        const size = p.size;
        switch (c.op) {
          case "long":
            return size > 0;
          case "short":
            return size < 0;
          case "flat":
            return size === 0;
          case "sizeAbove":
            return Math.abs(size) >= c.value;
          case "sizeBelow":
            return Math.abs(size) <= c.value;
          case "pnlAbove":
          case "pnlBelow": {
            const px = mk.mark(c.symbol)?.mark ?? null;
            if (px === null || size === 0) return false;
            const pnl = size * (px - p.entry);
            return c.op === "pnlAbove" ? pnl >= c.value : pnl <= c.value;
          }
        }
        return false;
      }
    }
  }
  /** The owner's positions as last read; a read starts in the background when they are older than POSITIONS_MS. */
  cachedPositions(a, now) {
    const hit = this.positionsOf.get(a.owner);
    if ((!hit || now - hit.at > POSITIONS_MS) && !hit?.loading) void this.loadPositions(a);
    return hit && hit.at > 0 ? hit.data : null;
  }
  async loadPositions(a) {
    const prev = this.positionsOf.get(a.owner);
    this.positionsOf.set(a.owner, { at: prev?.at ?? 0, data: prev?.data ?? {}, loading: true });
    try {
      let data;
      if (this.host.positions) data = await this.host.positions(a);
      else {
        const snap = await this.host.sodex.follower(a.owner);
        data = Object.fromEntries(Object.entries(snap.positions).map(([s, p]) => [s, { size: p.size, entry: p.entry }]));
      }
      this.positionsOf.set(a.owner, { at: Date.now(), data, loading: false });
      return data;
    } catch (e) {
      this.host.log.warn("algo: positions read failed", { owner: a.owner, error: String(e) });
      this.positionsOf.set(a.owner, { at: prev?.at ?? 0, data: prev?.data ?? {}, loading: false });
      return null;
    }
  }
  describeCondition(c) {
    const mins = (ms) => ms >= 6e4 ? `${Math.round(ms / 6e4)} min` : `${Math.round(ms / 1e3)} s`;
    const pct = (x) => `${(x * 100).toFixed(2).replace(/\.?0+$/, "")}%`;
    switch (c.type) {
      case "time":
        return `At ${new Date(c.at).toISOString().replace("T", " ").slice(0, 16)} UTC`;
      case "price":
        return `${c.symbol} ${c.source} ${c.op === "above" ? "\u2265" : "\u2264"} ${c.value}`;
      case "cross":
        return `${c.symbol} ${c.source} crosses ${c.dir === "up" ? "up through" : "down through"} ${c.value}`;
      case "move":
        return `${c.symbol} moves ${c.dir === "either" ? "\xB1" : c.dir === "up" ? "+" : "\u2212"}${pct(c.pct)} within ${mins(c.windowMs)}`;
      case "funding":
        return `${c.symbol} funding ${c.op === "above" ? "\u2265" : "\u2264"} ${pct(c.value)}`;
      case "oi":
        return `${c.symbol} open interest ${c.dir === "either" ? "\xB1" : c.dir === "up" ? "+" : "\u2212"}${pct(c.pct)} within ${mins(c.windowMs)}`;
      case "spread":
        return `${c.symbol} spread ${c.op === "above" ? "\u2265" : "\u2264"} ${c.bps} bp`;
      case "volume":
        return `${c.symbol} trades $${Math.round(c.aboveUsd).toLocaleString("en-US")} within ${mins(c.windowMs)}`;
      case "ratio":
        return `${c.symbol} / ${c.other} ${c.op === "above" ? "\u2265" : "\u2264"} ${c.value}`;
      case "position": {
        const what = {
          long: "is long",
          short: "is short",
          flat: "is flat",
          sizeAbove: `is at least ${c.value}`,
          sizeBelow: `is at most ${c.value}`,
          pnlAbove: `PnL \u2265 $${c.value}`,
          pnlBelow: `PnL \u2264 $${c.value}`
        };
        return `Your ${c.symbol} position ${what[c.op]}`;
      }
    }
  }
  /* -------------------------------------------------------------- sending ----- */
  clOrdIdFor(a) {
    a.childCount += 1;
    return `va-${a.id.slice(1, 13)}-${a.childCount.toString(36)}`;
  }
  /** Equity and gross exposure of the owner's account, read at most every ACCOUNT_MS. null: not readable. */
  async accountOf(a) {
    const hit = this.accounts.get(a.owner);
    if (hit && Date.now() - hit.at < ACCOUNT_MS) return hit;
    try {
      let v;
      if (this.host.account) v = await this.host.account(a);
      else {
        const snap = await this.host.sodex.follower(a.owner);
        const gross = Object.entries(snap.positions).reduce((x, [sym, p]) => x + Math.abs(p.size) * (this.market.mark(sym)?.mark ?? p.entry), 0);
        v = { equity: snap.equity, gross };
      }
      const row = { at: Date.now(), ...v };
      this.accounts.set(a.owner, row);
      return row;
    } catch (e) {
      this.host.log.warn("algo: account read failed", { owner: a.owner, error: String(e) });
      return null;
    }
  }
  /** Sign and send children (one batch on one market) and book them as live. */
  async send(a, m, list) {
    const s = a.spec;
    const sink = s.paper ? null : this.host.sinkFor(a);
    if (!s.paper && !sink) {
      await this.hold(a, "The trading key for this algo is not available here.");
      return;
    }
    const opening = list.some((x) => !(x.reduceOnly ?? s.reduceOnly));
    const ceiling = !s.paper ? this.host.policyFor?.(a)?.maxLeverage ?? null : null;
    const leverage = ceiling !== null ? Math.min(s.leverage ?? ceiling, ceiling) : s.leverage;
    if (sink && opening && leverage !== null && !this.leverageSet.has(`${a.owner}|${m.name}`)) {
      this.leverageSet.add(`${a.owner}|${m.name}`);
      await sink.setLeverage(a, m, Math.min(leverage, m.maxLeverage), s.marginMode ?? "cross").catch((e) => this.event(a, "error", `Leverage not set: ${e instanceof Error ? e.message : String(e)}`));
    }
    if (opening && ceiling !== null) {
      const acct = await this.accountOf(a);
      const room = acct ? acct.equity * ceiling - acct.gross : null;
      const notional = list.reduce((x, c) => x + (c.reduceOnly ?? s.reduceOnly ? 0 : c.quantity * c.price), 0);
      if (room === null || notional > room) {
        const one = list.length === 1 ? list[0] : null;
        const fit = one && room !== null && room > 0 ? floorStep(room / one.price, m) : 0;
        if (!one || fit < minChildQty(m, one.price)) {
          await this.hold(a, room === null ? "Held: your account could not be read for the leverage cap of your region." : `Held: the ${ceiling}x leverage cap for your region is reached.`);
          return;
        }
        list = [{ ...one, quantity: fit }];
      }
      const row = this.accounts.get(a.owner);
      if (row) row.gross += list.reduce((x, c) => x + (c.reduceOnly ?? s.reduceOnly ? 0 : c.quantity * c.price), 0);
    }
    const now = Date.now();
    const children = [];
    const reqs = [];
    for (const x of list) {
      const clOrdID = this.clOrdIdFor(a);
      const price2 = Number(dec3(x.price));
      const quantity = Number(dec3(x.quantity));
      const c = { clOrdID, orderId: null, side: x.side, price: price2, quantity, tif: x.tif, reduceOnly: x.reduceOnly ?? s.reduceOnly, filled: 0, value: 0, state: "sending", placedAt: now, updatedAt: now, cancelling: false, tag: x.tag };
      children.push(c);
      reqs.push({ clOrdID, side: c.side, price: dec3(price2), quantity: dec3(quantity), tif: c.tif, reduceOnly: c.reduceOnly });
      a.children.push(c);
      this.byClOrd.set(clOrdID, a.id);
    }
    this.trimChildren(a);
    this.dirty.add(a.id);
    for (const c of children) await this.event(a, "order", `${c.tif === "ioc" ? "Take" : "Rest"} ${c.side} ${c.quantity} @ ${c.price} (${c.tag}).`, c);
    let results;
    if (s.paper) results = this.paperPlace(a, m, children);
    else results = await sink.place(a, m, reqs);
    for (const c of children) {
      const r = results.find((x) => x.clOrdID === c.clOrdID) ?? { clOrdID: c.clOrdID, ok: false, orderId: null, error: "no answer for this order", outcomeUnknown: true };
      c.updatedAt = Date.now();
      if (r.orderId) c.orderId = r.orderId;
      if (r.ok) {
        if (c.state === "sending") c.state = "open";
        a.k.consecRejects = 0;
      } else if (r.outcomeUnknown) {
        c.state = "unknown";
        await this.event(a, "error", `No answer from SoDEX for ${c.tag}; checking what happened (never re-sent).`, c);
      } else {
        c.state = "done";
        a.rejects++;
        a.k.consecRejects = Number(a.k.consecRejects ?? 0) + 1;
        await this.event(a, "error", `SoDEX refused ${c.tag}: ${r.error}`, c);
      }
    }
    if (Number(a.k.consecRejects ?? 0) >= MAX_CONSEC_REJECTS) await this.end(a, "failed", `SoDEX refused ${MAX_CONSEC_REJECTS} orders in a row; stopped. The last reason is in the log.`);
    this.host.onChange?.(a.id);
  }
  async cancelChildren(a, m, list) {
    const open = list.filter((c) => LIVE.has(c.state) && !c.cancelling);
    if (!open.length) return;
    for (const c of open) {
      c.cancelling = true;
      c.updatedAt = Date.now();
    }
    this.dirty.add(a.id);
    if (a.spec.paper) {
      for (const c of open) this.paperCancel(c.clOrdID);
      return;
    }
    const sink = this.host.sinkFor(a);
    if (!sink) return;
    try {
      await sink.cancel(a, m, open.map((c) => c.clOrdID));
    } catch (e) {
      for (const c of open) c.cancelling = false;
      await this.event(a, "error", `Cancel failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /** Cancel every resting child (pause, hold, end). */
  async pullResting(a, keep = []) {
    const m = this.markets.get(a.spec.symbol);
    if (!m) return;
    const resting = this.live(a).filter((c) => !keep.includes(c.clOrdID) && c.state === "open" && !c.cancelling);
    if (resting.length) await this.cancelChildren(a, m, resting);
  }
  trimChildren(a) {
    const done = a.children.filter((c) => !LIVE.has(c.state));
    if (done.length <= DONE_KEPT) return;
    const drop = new Set(done.slice(0, done.length - DONE_KEPT).map((c) => c.clOrdID));
    a.children = a.children.filter((c) => !drop.has(c.clOrdID));
  }
  /* ------------------------------------------------------------- the books ----- */
  onOrderUpdate(u) {
    const id = this.byClOrd.get(u.clOrdID);
    const a = id ? this.algos.get(id) : void 0;
    if (!a) return;
    const c = a.children.find((x) => x.clOrdID === u.clOrdID);
    if (!c) {
      const x = (a.exitOrders ?? []).find((e) => e.clOrdID === u.clOrdID);
      if (x) this.onExitUpdate(a, x, u);
      return;
    }
    const before = a.filled;
    this.applyFill(a, c, u.filledQty, u.filledValue, u.maker);
    if (a.filled > before && FINAL_STATUSES.has(a.status) && a.spec.exits) {
      const m = this.markets.get(a.spec.symbol);
      if (m) void this.syncExits(a, m, true);
    }
    if (u.orderId) c.orderId = u.orderId;
    c.updatedAt = Date.now();
    if (FINAL_ORDER.test(u.status)) {
      const was = c.state;
      c.state = "done";
      c.cancelling = false;
      if (c.tif === "ioc" && c.filled <= 1e-12) a.k.missAt = Date.now();
      if (u.status === "REJECTED" && was !== "done") {
        a.rejects++;
        a.k.consecRejects = Number(a.k.consecRejects ?? 0) + 1;
        void this.event(a, "error", `SoDEX rejected ${c.tag}${u.reason ? `: ${u.reason}` : ""}.`, c);
      }
      this.onChildDone(a, c);
    } else if (c.state === "sending" || c.state === "unknown") c.state = "open";
    if (FINAL_STATUSES.has(a.status) && c.state === "open" && c.tif !== "ioc" && !c.cancelling && !(a.k.kept ?? []).includes(c.clOrdID)) {
      const m = this.markets.get(a.spec.symbol);
      if (m) void this.cancelChildren(a, m, [c]);
    }
    this.dirty.add(a.id);
    this.host.onChange?.(a.id);
  }
  applyFill(a, c, cumQty, cumValue, maker) {
    const dq = cumQty - c.filled;
    if (!(dq > 1e-12)) return;
    const dv = cumValue > c.value ? cumValue - c.value : dq * c.price;
    c.filled = cumQty;
    c.value = cumValue > 0 ? cumValue : c.value + dv;
    a.filled += dq;
    a.filledValue += dv;
    const isMaker = maker ?? c.tif !== "ioc";
    if (isMaker) a.makerQty += dq;
    const m = this.markets.get(a.spec.symbol);
    const rate = (isMaker ? m?.makerFee ?? (m?.takerFee ?? 4e-4) / 2 : m?.takerFee ?? 4e-4) + (this.host.builderRate?.(a) ?? 0);
    a.fees += dv * rate;
    if (a.k.consecRejects) a.k.consecRejects = 0;
    void this.event(a, "fill", `Filled ${dec3(dq)} @ ${(dv / dq).toPrecision(8).replace(/\.?0+$/, "")}${isMaker ? " (maker)" : ""}.`, { ...c, quantity: dq, price: dv / dq });
  }
  /* --------------------------------------------------------------- exits ----- */
  /**
   * Keep the exits in line with what the entry filled: a take-profit and/or a
   * stop-loss, SoDEX position stops sized to the filled amount at the levels
   * the spec names (a price, or a distance from the average fill). Resized at
   * most every EXITS_RESIZE_MS while the entry fills (cancel, then place), at
   * once when it ends (`final`). Nothing once one of them has filled.
   */
  async syncExits(a, m, final) {
    const s = a.spec;
    if (!s.exits || !opensPosition(s) || a.k.exitsDone || this.exitsBusy.has(a.id)) return;
    this.exitsBusy.add(a.id);
    try {
      a.exitOrders ??= [];
      const live = this.liveExits(a);
      if (live.some((x) => x.state !== "open" || x.cancelling)) return;
      const size = floorStep(a.filled, m);
      if (size < Math.max(Number(m.stepSize), Number(m.minQuantity) || 0)) return;
      const covered = Number(a.k.exitsSize ?? 0);
      if (live.length && Math.abs(size - covered) < Number(m.stepSize) / 2) return;
      const now = Date.now();
      if (!final && live.length && now - Number(a.k.exitsAt ?? 0) < EXITS_RESIZE_MS) return;
      if (live.length) {
        await this.cancelExits(a, m, live);
        if (!final) return;
      }
      const lv = exitLevels(s.side, s.exits, a.filledValue / a.filled);
      const close = s.side === "buy" ? "sell" : "buy";
      const stops = [];
      const xs = [];
      for (const kind of ["tp", "sl"]) {
        const p = kind === "tp" ? lv.tp : lv.sl;
        if (p === null || !(p > 0)) continue;
        const clOrdID = this.clOrdIdFor(a);
        const triggerPrice = snapPrice(p, m);
        stops.push({ clOrdID, side: close, quantity: dec3(size), triggerPrice, kind });
        xs.push({ clOrdID, orderId: null, side: close, price: Number(triggerPrice), quantity: size, tif: "ioc", reduceOnly: true, filled: 0, value: 0, state: "sending", placedAt: now, updatedAt: now, cancelling: false, tag: kind === "tp" ? "take-profit" : "stop-loss", exit: kind });
        this.byClOrd.set(clOrdID, a.id);
      }
      if (!stops.length) return;
      a.exitOrders.push(...xs);
      a.k.exitsSize = size;
      a.k.exitsAt = now;
      this.dirty.add(a.id);
      await this.event(a, "order", `Exits for ${dec3(size)} ${m.base}: ${xs.map((x) => `${x.tag} at ${x.price}`).join(", ")} (${s.paper ? "paper: watched against the mark" : "SoDEX holds them"}; when one fills the other is cancelled).`);
      const sink = s.paper ? null : this.host.sinkFor(a);
      const results = s.paper ? stops.map((st) => ({ clOrdID: st.clOrdID, ok: true, orderId: `paper-${st.clOrdID}`, error: null, outcomeUnknown: false })) : sink ? await sink.placeStops(a, m, stops) : stops.map((st) => ({ clOrdID: st.clOrdID, ok: false, orderId: null, error: "the trading key is not available here", outcomeUnknown: false }));
      for (const x of xs) {
        const r = results.find((y) => y.clOrdID === x.clOrdID);
        x.updatedAt = Date.now();
        if (r?.orderId) x.orderId = r.orderId;
        if (r?.ok) x.state = "open";
        else if (r?.outcomeUnknown) x.state = "unknown";
        else {
          x.state = "done";
          await this.event(a, "error", `SoDEX refused the ${x.tag}: ${r?.error ?? "no answer"}`);
        }
      }
      const done = a.exitOrders.filter((x) => !LIVE.has(x.state));
      if (done.length > 12) a.exitOrders = a.exitOrders.filter((x) => LIVE.has(x.state) || done.slice(-12).includes(x));
      this.syncWatch();
      this.host.onChange?.(a.id);
    } finally {
      this.exitsBusy.delete(a.id);
    }
  }
  async cancelExits(a, m, list) {
    const open = list.filter((x) => LIVE.has(x.state) && !x.cancelling);
    if (!open.length) return;
    for (const x of open) x.cancelling = true;
    this.dirty.add(a.id);
    if (a.spec.paper) {
      for (const x of open) {
        x.state = "done";
        x.cancelling = false;
      }
      return;
    }
    const sink = this.host.sinkFor(a);
    if (!sink) return;
    try {
      await sink.cancel(a, m, open.map((x) => x.clOrdID));
    } catch (e) {
      for (const x of open) x.cancelling = false;
      await this.event(a, "error", `The exits could not be cancelled: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  /** An exit's update: its fill, and the other one cancelled when it fills (one cancels the other). */
  onExitUpdate(a, x, u) {
    const dq = u.filledQty - x.filled;
    if (dq > 1e-12) {
      const dv = u.filledValue > x.value ? u.filledValue - x.value : dq * x.price;
      x.filled = u.filledQty;
      x.value += dv;
      void this.event(a, "fill", `${x.tag === "take-profit" ? "Take-profit" : "Stop-loss"} filled ${dec3(dq)} @ ${(dv / dq).toPrecision(8).replace(/\.?0+$/, "")}.`, { ...x, quantity: dq, price: dv / dq });
    }
    if (u.orderId) x.orderId = u.orderId;
    x.updatedAt = Date.now();
    if (FINAL_ORDER.test(u.status)) {
      x.state = "done";
      x.cancelling = false;
    } else if (x.state === "sending" || x.state === "unknown") x.state = "open";
    if (x.filled > 1e-12 && !a.k.exitsDone) {
      a.k.exitsDone = true;
      const others = this.liveExits(a).filter((o) => o.clOrdID !== x.clOrdID);
      const m = this.markets.get(a.spec.symbol);
      if (others.length && m) {
        void this.cancelExits(a, m, others);
        void this.event(a, "info", `${x.tag === "take-profit" ? "Take-profit" : "Stop-loss"} hit: the ${others.map((o) => o.tag).join(" and ")} is cancelled (one cancels the other).`);
      }
    }
    if (!this.liveExits(a).length) this.syncWatch();
    this.dirty.add(a.id);
    this.host.onChange?.(a.id);
  }
  /** Paper exits fire here, on the mark, as SoDEX would fire the real ones. */
  checkPaperExits() {
    for (const a of this.algos.values()) {
      if (!a.spec.paper || a.k.exitsDone) continue;
      const live = this.liveExits(a).filter((x) => x.state === "open" && !x.cancelling);
      if (!live.length) continue;
      const mk = this.market.mark(a.spec.symbol)?.mark ?? null;
      if (mk === null) continue;
      const long = a.spec.side === "buy";
      const hit = live.find((x) => x.exit === "tp" ? long ? mk >= x.price : mk <= x.price : long ? mk <= x.price : mk >= x.price);
      if (hit) this.onOrderUpdate({ clOrdID: hit.clOrdID, orderId: hit.orderId, symbol: a.spec.symbol, status: "FILLED", filledQty: hit.quantity, filledValue: hit.quantity * mk, maker: false, reason: null, at: Date.now() });
    }
  }
  onChildDone(a, c) {
    if (a.spec.kind === "iceberg" && c.filled >= c.quantity - 1e-12) {
      const s = a.spec;
      a.k.refillAt = Date.now() + Math.max(0, jitter(s.refillMs, s.refillJitter, makeRng(a.seed ^ a.childCount)));
    }
  }
  onPrint(p) {
    for (const a of this.algos.values()) {
      if (a.status !== "running" && a.status !== "waiting") continue;
      if (a.spec.symbol !== p.symbol || a.startedAt === null || p.at < a.startedAt) continue;
      if (p.buyer === a.accountId || p.seller === a.accountId) continue;
      a.marketQty += p.qty;
      a.marketValue += p.qty * p.price;
      this.dirty.add(a.id);
    }
    if (this.paper.size) this.paperOnPrint(p);
  }
  /**
   * Settle children SoDEX has not told us about: an IOC with no final update,
   * a cancel with no answer, a write with no answer. Open orders first; the
   * order history (drip-limited) only when an order is gone from them.
   */
  async settleStale(a, m, now) {
    if (a.spec.paper || this.lookupBusy) return;
    for (const c of a.children) if (c.state === "sending" && now - c.placedAt > SENDING_MAX_MS) c.state = "unknown";
    const stale = a.children.filter((c) => c.state === "unknown" || c.state === "open" && (c.tif === "ioc" && now - c.updatedAt > STALE_IOC_MS || c.cancelling && now - c.updatedAt > STALE_IOC_MS));
    if (!stale.length) return;
    this.lookupBusy = true;
    try {
      const open = await this.lookupOrders(a, m.name, false);
      const missing = [];
      for (const c of stale) {
        const row = open.find((r) => r.clOrdID === c.clOrdID);
        if (row) {
          this.applyFill(a, c, row.executedQty, row.executedValue, null);
          c.state = "open";
          c.orderId = row.orderId;
          c.updatedAt = now;
          if (c.cancelling) {
            c.cancelling = false;
            await this.cancelChildren(a, m, [c]);
          }
        } else missing.push(c);
      }
      if (missing.length && now - this.lastHistoryAt >= HISTORY_EVERY_MS) {
        this.lastHistoryAt = now;
        const hist = await this.lookupOrders(a, m.name, true);
        for (const c of missing) {
          const row = hist.find((r) => r.clOrdID === c.clOrdID);
          if (row) this.applyFill(a, c, row.executedQty, row.executedValue, null);
          if (row || now - c.placedAt > 12e4) {
            if (!row) await this.event(a, "info", `SoDEX does not list ${c.tag}; counted as filled ${dec3(c.filled)}.`, c);
            c.state = "done";
            c.cancelling = false;
            this.onChildDone(a, c);
          }
        }
      }
      this.dirty.add(a.id);
    } catch (e) {
      this.host.log.warn("algo: order lookup failed", { algo: a.id, error: String(e) });
    } finally {
      this.lookupBusy = false;
    }
  }
  async lookupOrders(a, symbol2, history) {
    if (this.host.lookup) return this.host.lookup(a, symbol2, history);
    const path = `/api/v1/perps/accounts/${a.owner}/orders${history ? "/history" : ""}?symbol=${encodeURIComponent(symbol2)}${history ? "&limit=100" : ""}`;
    const data = await this.host.sodex.get(path);
    const list = Array.isArray(data) ? data : data?.orders ?? [];
    return list.filter((r) => typeof r.clOrdID === "string").map((r) => ({ clOrdID: r.clOrdID, orderId: String(r.orderID ?? ""), status: String(r.status ?? ""), executedQty: Number(r.executedQty ?? 0) || 0, executedValue: Number(r.executedValue ?? 0) || 0 }));
  }
  /**
   * The owner's signed position on `symbol`, read now. A paper algo uses what
   * its own paper fills built, and otherwise the real position (only read).
   */
  async positionOf(a, symbol2) {
    const paperPos = a.k.paperPos;
    if (a.spec.paper && typeof paperPos === "number" && paperPos !== 0) return paperPos;
    try {
      if (this.host.position) return await this.host.position(a, symbol2);
      const book = await this.loadPositions(a);
      return book ? book[symbol2]?.size ?? 0 : null;
    } catch (e) {
      this.host.log.warn("algo: position read failed", { algo: a.id, error: String(e) });
      return null;
    }
  }
  async profileFor(symbol2, start, durationMs, slices, lookbackDays) {
    const { interval, ms } = profileCandles(lookbackDays);
    const from = start - lookbackDays * DAY_MS2;
    const to = start - DAY_MS2 + durationMs;
    const candles = [];
    if (this.host.candles) candles.push(...await this.host.candles(symbol2, interval, from, to));
    else {
      for (let t = from; t < to; t += 1e3 * ms) {
        const data = await this.host.sodex.get(`/api/v1/perps/markets/${encodeURIComponent(symbol2)}/klines?interval=${interval}&limit=1000&startTime=${t}&endTime=${Math.min(to, t + 1e3 * ms)}`);
        const list = Array.isArray(data) ? data : data?.klines ?? [];
        for (const k of list) {
          const t0 = Array.isArray(k) ? Number(k[0]) : Number(k.t ?? k.openTime);
          const v = Array.isArray(k) ? Number(k[5]) : Number(k.v ?? k.volume);
          if (Number.isFinite(t0) && Number.isFinite(v)) candles.push({ t: t0, v });
        }
      }
    }
    if (!candles.length) return null;
    return volumeProfile(candles, ms, start, durationMs, slices, lookbackDays);
  }
  async problemOf(a, now) {
    if (!this.host.problem) return null;
    const hit = this.problems.get(a.id);
    if (hit && now - hit.at < PROBLEM_RECHECK_MS) return hit.problem;
    let problem = null;
    try {
      problem = await this.host.problem(a);
    } catch (e) {
      this.host.log.warn("algo: readiness check failed", { algo: a.id, error: String(e) });
      problem = hit?.problem ?? null;
    }
    this.problems.set(a.id, { at: now, problem });
    return problem;
  }
  isDone(a, m) {
    const t = this.targetOf(a);
    if (t === null) return false;
    return t - a.filled < Math.max(Number(m.stepSize), Number(m.minQuantity) || 0) - 1e-12 && !this.live(a).length;
  }
  /* -------------------------------------------------------------- paper ----- */
  paperPlace(a, m, children) {
    const q = this.market.quote(m.name);
    const out = [];
    for (const c of children) {
      out.push({ clOrdID: c.clOrdID, ok: true, orderId: `paper-${c.clOrdID}`, error: null, outcomeUnknown: false });
      const touch = q ? c.side === "buy" ? q.ask : q.bid : null;
      const crosses = touch !== null && (c.side === "buy" ? c.price >= touch : c.price <= touch);
      const emit = (status, filled, value, maker) => timers.after(0, () => this.onOrderUpdate({ clOrdID: c.clOrdID, orderId: `paper-${c.clOrdID}`, symbol: m.name, status, filledQty: filled, filledValue: value, maker, reason: status === "REJECTED" ? "post-only order would take" : null, at: Date.now() }));
      if (c.tif === "ioc") {
        if (crosses) {
          this.paperPosition(a, c.side, c.quantity);
          emit("FILLED", c.quantity, c.quantity * touch, false);
        } else emit("CANCELED", 0, 0, null);
        continue;
      }
      if (crosses) {
        if (c.tif === "gtx") emit("REJECTED", 0, 0, null);
        else {
          this.paperPosition(a, c.side, c.quantity);
          emit("FILLED", c.quantity, c.quantity * touch, false);
        }
        continue;
      }
      this.paper.set(c.clOrdID, { algoId: a.id, clOrdID: c.clOrdID, symbol: m.name, side: c.side, price: c.price, left: c.quantity, filled: 0, value: 0 });
      emit("NEW", 0, 0, null);
    }
    return out;
  }
  paperPosition(a, side, qty2) {
    a.k.paperPos = Number(a.k.paperPos ?? 0) + (side === "buy" ? qty2 : -qty2);
  }
  paperCancel(clOrdID) {
    const o = this.paper.get(clOrdID);
    this.paper.delete(clOrdID);
    const id = this.byClOrd.get(clOrdID);
    const a = id ? this.algos.get(id) : void 0;
    const c = a?.children.find((x) => x.clOrdID === clOrdID);
    timers.after(0, () => this.onOrderUpdate({ clOrdID, orderId: `paper-${clOrdID}`, symbol: o?.symbol ?? a?.spec.symbol ?? "", status: "CANCELED", filledQty: o?.filled ?? c?.filled ?? 0, filledValue: o?.value ?? c?.value ?? 0, maker: null, reason: null, at: Date.now() }));
  }
  /** A resting paper order fills as the tape trades through its price (a sell print at or under a buy, and so on). */
  paperOnPrint(p) {
    for (const o of this.paper.values()) {
      if (o.symbol !== p.symbol) continue;
      const through = o.side === "buy" ? p.price <= o.price && p.taker === "sell" : p.price >= o.price && p.taker === "buy";
      if (!through) continue;
      const q = Math.min(o.left, p.qty);
      o.left -= q;
      o.filled += q;
      o.value += q * o.price;
      const a = this.algos.get(o.algoId);
      if (a) this.paperPosition(a, o.side, q);
      const done = o.left <= 1e-12;
      if (done) this.paper.delete(o.clOrdID);
      this.onOrderUpdate({ clOrdID: o.clOrdID, orderId: `paper-${o.clOrdID}`, symbol: o.symbol, status: done ? "FILLED" : "PARTIALLY_FILLED", filledQty: o.filled, filledValue: o.value, maker: true, reason: null, at: p.at });
    }
  }
  /* -------------------------------------------------------------- status ----- */
  async setStatus(a, status, reason) {
    if (a.status === status && a.statusReason === reason) return;
    const changed = a.status !== status;
    a.status = status;
    a.statusReason = reason;
    a.updatedAt = Date.now();
    await this.save(a);
    if (changed && status !== "running") await this.event(a, "status", reason ?? status);
    else if (reason && changed) await this.event(a, "status", reason);
    this.host.onChange?.(a.id);
  }
  async hold(a, reason) {
    this.heldNow.add(a.id);
    if (a.status === "scheduled") {
      if (a.statusReason !== reason) {
        a.statusReason = reason;
        this.dirty.add(a.id);
      }
      return;
    }
    if (a.status === "waiting" && a.statusReason === reason) return;
    a.status = "waiting";
    a.statusReason = reason;
    a.updatedAt = Date.now();
    this.dirty.add(a.id);
    await this.event(a, "status", reason);
    this.host.onChange?.(a.id);
  }
  async run(a) {
    if (a.status === "running") return;
    if (a.status === "waiting") {
      a.status = "running";
      a.statusReason = null;
      a.updatedAt = Date.now();
      this.dirty.add(a.id);
      this.host.onChange?.(a.id);
    }
  }
  async end(a, status, reason, o = {}) {
    if (FINAL_STATUSES.has(a.status)) return;
    await this.pullResting(a, o.keep ?? []);
    if (o.keep?.length) a.k.kept = o.keep;
    for (const id of o.keep ?? []) this.paper.delete(id);
    const m = this.markets.get(a.spec.symbol);
    if (m && a.spec.exits && a.filled > 0) await this.syncExits(a, m, true);
    a.status = status;
    a.statusReason = reason;
    a.endedAt = Date.now();
    a.updatedAt = a.endedAt;
    await this.save(a);
    await this.event(a, "status", reason);
    if (status === "cancelled" && this.liveExits(a).length) await this.event(a, "info", "Its exits stay on SoDEX for what filled; cancel them in your open orders if you do not want them.");
    this.syncWatch();
    this.host.onChange?.(a.id);
  }
  need(id) {
    const a = this.algos.get(id);
    if (!a) throw new Error("No such algo.");
    return a;
  }
  async save(a) {
    this.dirty.delete(a.id);
    await this.host.store.saveAlgo(a).catch((e) => this.host.log.error("algo: not saved", { algo: a.id, error: String(e) }));
  }
  async flush() {
    const ids = [...this.dirty];
    this.dirty.clear();
    for (const id of ids) {
      const a = this.algos.get(id);
      if (a) await this.host.store.saveAlgo(a).catch((e) => this.host.log.error("algo: not saved", { algo: id, error: String(e) }));
      this.host.onChange?.(id);
    }
  }
  async event(a, kind, text, c) {
    const at = Date.now();
    const e = {
      // Sorts by time, then by the order it was written: lines of one millisecond keep their order.
      id: `e${at.toString(36)}${(++this.eventSeq).toString(36).padStart(6, "0")}${randomId().slice(0, 4)}`,
      algoId: a.id,
      owner: a.owner,
      at,
      kind,
      text,
      clOrdID: c?.clOrdID ?? null,
      side: c?.side ?? null,
      price: c?.price ?? null,
      qty: c?.quantity ?? null,
      paper: a.spec.paper
    };
    await this.host.store.addAlgoEvent(e).catch((err) => this.host.log.error("algo: event not saved", { error: String(err) }));
  }
};

// packages/copy-engine/src/index.ts
var COPY_ENGINE_VERSION = "1.1.0";

// apps/executor/src/service.ts
import { existsSync as existsSync2 } from "node:fs";
import { DatabaseSync as DatabaseSync2 } from "node:sqlite";
var ApiError = class extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
  status;
  code;
};
var SESSION_TTL_MS = 12 * 60 * 6e4;
var KEY_RECHECK_MS = 10 * 6e4;
var ExecutorService = class {
  constructor(cfg, db, secrets, deps) {
    this.cfg = cfg;
    this.db = db;
    this.secrets = secrets;
    this.deps = deps;
    this.executorId = cfg.kind === "hosted" ? `valuedesk-${cfg.network}-tokyo` : this.selfId();
    this.keyName = cfg.kind === "hosted" ? "vd-copy-tokyo" : "vd-copy-self";
    this.pairingCode = cfg.kind === "self" && !this.owner() ? randomId().slice(0, 8).toUpperCase() : null;
    this.sodex = new SodexClient({ network: cfg.network, fetch: deps.fetch });
    this.hyperliquid = new HyperliquidClient(deps.fetch);
    this.runtime = new CopyRuntime({
      store: db,
      sodex: this.sodex,
      hyperliquid: this.hyperliquid,
      factory: deps.factory,
      network: cfg.network,
      hlMode: cfg.kind === "hosted" ? "firehose" : "user",
      log: deps.log,
      sinkFor: (s) => this.sinkFor(s),
      builderFor: async (s) => cfg.builderId > 0 ? { id: cfg.builderId, fee: copyFeeFor(this.volumeOf(s.owner)) } : null,
      policyFor: (s) => regionPolicy(s.country, s.observedCountry),
      keyProblem: (s) => this.keyProblem(s.owner)
    });
    this.algos = new AlgoRuntime({
      store: db,
      sodex: this.sodex,
      network: cfg.network,
      factory: deps.factory,
      log: deps.log,
      sinkFor: (a) => this.algoSink(a),
      builderRate: (a) => cfg.builderId > 0 ? copyFeeFor(this.volumeOf(a.owner)) / 1e5 : 0,
      problem: (a) => this.algoProblem(a),
      // The copy region rules, from the country declared with the terms and the one the request came from.
      policyFor: (a) => regionPolicy(a.country ?? null, a.observedCountry ?? null)
    });
  }
  cfg;
  db;
  secrets;
  deps;
  executorId;
  keyName;
  runtime;
  /**
   * Algo orders (TWAP, VWAP, POV, ...): the same engine package, the same key
   * the follower registered for this executor, the same nonce sequence, the
   * same builder (the copy fee ladder), the same terms and region rules.
   */
  algos;
  sodex;
  hyperliquid;
  nonces = createMemoryNonceManager();
  paper = new PaperSink();
  signers = /* @__PURE__ */ new Map();
  volumes = /* @__PURE__ */ new Map();
  builderDb = null;
  /** Self-hosted, not yet paired: the code printed at start. */
  pairingCode;
  async start() {
    await this.runtime.start();
    await this.algos.start();
  }
  async stop() {
    await this.algos.stop();
    await this.runtime.stop();
    this.builderDb?.close();
  }
  selfId() {
    let id = this.db.meta("executorId");
    if (!id) {
      id = randomId("self-");
      this.db.setMeta("executorId", id);
    }
    return id;
  }
  /** Self-hosted: the one wallet it serves (configured, or paired), else null. */
  owner() {
    return this.cfg.owner ?? this.db.meta("owner");
  }
  /* ------------------------------------------------------------- info ----- */
  info(ctx) {
    return {
      executorId: this.executorId,
      kind: this.cfg.kind,
      version: COPY_ENGINE_VERSION,
      network: this.cfg.network,
      location: this.cfg.location,
      open: this.cfg.kind === "hosted" ? this.cfg.open : this.owner() !== null,
      owner: this.cfg.kind === "self" ? this.owner() : null,
      builder: this.cfg.builderId > 0 ? { id: this.cfg.builderId, ladder: COPY_FEE_LADDER.map((s) => ({ ...s })), windowDays: COPY_FEE_WINDOW_DAYS } : null,
      termsVersion: COPY_TERMS_VERSION,
      viewerCountry: ctx.viewerCountry,
      keyTtlDaysMax: this.cfg.keyTtlDaysMax,
      keyName: this.keyName,
      algos: { maxPerOwner: this.cfg.maxAlgosPerOwner },
      features: [...EXECUTOR_FEATURES]
    };
  }
  health() {
    const all = this.runtime.list();
    const v = all[0] ? this.runtime.view(all[0].id) : null;
    const algos = this.algos.list().filter((a) => !FINAL_STATUSES.has(a.status)).length;
    return { ok: true, copies: all.length, active: all.filter((s) => s.status === "active").length, algos, feeds: { sodex: v?.feeds.sodex ?? true } };
  }
  /* --------------------------------------------------------- requests ----- */
  /** Verify, check the action and the wallet, record. Returns the owner and the payload. */
  accept(req, want, ctx) {
    const q = req;
    const termsWide = want === "accept-terms" && q?.action === "accept-terms" && q.executor === COPY_TERMS_EXECUTOR;
    const v = verifyCopyRequest(req, { executor: termsWide ? COPY_TERMS_EXECUTOR : this.executorId });
    if (!v.ok) throw new ApiError(401, "signature", v.error);
    const r = req;
    const wanted = Array.isArray(want) ? want : [want];
    if (!wanted.includes(r.action)) throw new ApiError(400, "action", `this endpoint takes ${wanted.join(" / ")}, not ${r.action}`);
    const owner = r.owner.toLowerCase();
    if (this.cfg.kind === "self") {
      const paired = this.owner();
      if (!paired) {
        const code = ctx.pairingCode?.trim().toUpperCase();
        if (r.action !== "session" || !code || code !== this.pairingCode) {
          throw new ApiError(403, "unpaired", "This executor is not paired with a wallet yet. Enter the pairing code it printed when it started.");
        }
        this.db.setMeta("owner", owner);
        this.deps.log.info("executor paired", { owner });
      } else if (paired !== owner) {
        throw new ApiError(403, "owner", "This executor serves another wallet.");
      }
    }
    const at = Date.now();
    const recorded = this.db.addConsent({
      owner,
      action: r.action,
      digest: v.digest,
      signature: r.signature,
      chainId: r.chainId,
      payload: r.payload,
      nonce: r.nonce,
      at,
      viewerCountry: ctx.viewerCountry
    });
    if (!recorded) throw new ApiError(409, "replay", "This signed request was already used. Sign it again.");
    return {
      owner,
      payload: v.payload && typeof v.payload === "object" ? v.payload : {},
      consent: { action: r.action, digest: v.digest, signature: r.signature, chainId: r.chainId, payload: r.payload, at }
    };
  }
  session(req, ctx) {
    const { owner } = this.accept(req, "session", ctx);
    return this.secrets.issueSession(owner, SESSION_TTL_MS);
  }
  /** The wallet behind a session token, or a 401. */
  authenticate(token) {
    const owner = this.secrets.readSession(token);
    if (!owner) throw new ApiError(401, "session", "Sign in to the executor again (the session expired).");
    if (this.cfg.kind === "self" && this.owner() !== owner) throw new ApiError(403, "owner", "This executor serves another wallet.");
    return owner;
  }
  acceptTerms(req, ctx) {
    const { owner, payload } = this.accept(req, "accept-terms", ctx);
    const p = payload;
    if (p.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, "terms-version", `These are the copy terms of ${COPY_TERMS_VERSION}; reload the page and accept them again.`);
    if (typeof p.termsHash !== "string" || !/^0x[0-9a-f]{64}$/.test(p.termsHash)) throw new ApiError(400, "terms-hash", "termsHash must be the keccak256 of the terms text.");
    const country = normaliseCountry(p.country);
    if (!country) throw new ApiError(400, "country", "Choose your country of residence.");
    for (const k of ["adult", "notUsPerson", "ownDecision", "risksUnderstood"]) {
      if (p[k] !== true) throw new ApiError(400, "statements", "Every statement must be confirmed to copy trades.");
    }
    const policy = regionPolicy(country, ctx.viewerCountry);
    this.db.setTerms(owner, { termsVersion: p.termsVersion, termsHash: p.termsHash, country, observedCountry: normaliseCountry(ctx.viewerCountry), acceptedAt: Date.now() });
    if (!policy.allowed) throw new ApiError(451, "region", policy.reason ?? "Copy trading is not available in your region.");
    return this.me(owner, ctx);
  }
  me(owner, ctx) {
    const terms = this.db.terms(owner);
    const current = terms && terms.termsVersion === COPY_TERMS_VERSION ? terms : null;
    return {
      owner,
      terms: current,
      policy: regionPolicy(current?.country ?? null, ctx.viewerCountry),
      key: this.keyInfo(owner),
      copies: this.runtime.list(owner).map((s) => this.runtime.view(s.id)).filter((v) => v !== null).sort((a, b) => b.subscription.createdAt - a.subscription.createdAt)
    };
  }
  /* ------------------------------------------------------------- keys ----- */
  keyInfo(owner) {
    const k = this.db.key(owner, "pending") ?? this.db.key(owner, "active");
    return k ? { address: k.address, name: k.name, expiresAt: k.expiresAt, registered: k.registered, createdAt: k.createdAt } : null;
  }
  /** A new key for the follower to register on SoDEX (the previous one keeps trading until the new one is registered). */
  createKey(req, ctx) {
    const { owner, payload } = this.accept(req, "create-key", ctx);
    this.needTerms(owner, ctx);
    const p = payload;
    const days = Math.floor(Number(p.days));
    if (!Number.isFinite(days) || days < 1 || days > this.cfg.keyTtlDaysMax) throw new ApiError(400, "days", `A key may live 1 to ${this.cfg.keyTtlDaysMax} days.`);
    const { address, sealed } = this.secrets.newKey(this.cfg.network, owner);
    this.db.putKey({ owner, slot: "pending", address, name: this.keyName, sealed, createdAt: Date.now(), expiresAt: null, registered: false, checkedAt: null });
    this.deps.log.info("copy key created", { owner, key: address });
    return { address, name: this.keyName, maxDays: this.cfg.keyTtlDaysMax, days };
  }
  /** Ask SoDEX whether the follower registered the key; a registered pending key becomes the active one. */
  async verifyKey(owner) {
    const pending = this.db.key(owner, "pending");
    if (pending) {
      const r = await this.sodex.keyRegistered(owner, pending.name, pending.address);
      if (r.ok) {
        this.db.markKey(owner, "pending", true, r.expiresAt, Date.now());
        this.db.promoteKey(owner);
        this.signers.delete(owner);
        for (const s of this.runtime.list(owner)) void this.runtime.checkReady(s);
      }
    }
    const active = this.db.key(owner, "active");
    if (active && (!pending || this.db.key(owner, "pending"))) {
      const r = await this.sodex.keyRegistered(owner, active.name, active.address);
      this.db.markKey(owner, "active", r.ok, r.expiresAt, Date.now());
    }
    return this.keyInfo(owner);
  }
  /** Stop every copy and algo and forget the keys. The follower revokes the key on SoDEX with their wallet. */
  async deleteKey(req, ctx) {
    const { owner, payload } = this.accept(req, "delete-key", ctx);
    await this.algos.cancelAll(owner);
    await this.runtime.stopAll(owner, { close: payload.close === true });
    this.db.deleteKeys(owner);
    this.signers.delete(owner);
    return this.me(owner, ctx);
  }
  async keyProblem(owner) {
    const k = this.db.key(owner, "active");
    if (!k) return "No copy key is registered for this executor. Approve one in copy setup.";
    const now = Date.now();
    if (!k.registered || !k.checkedAt || now - k.checkedAt > KEY_RECHECK_MS) {
      const r = await this.sodex.keyRegistered(owner, k.name, k.address);
      this.db.markKey(owner, "active", r.ok, r.expiresAt, now);
      if (!r.ok) {
        this.signers.delete(owner);
        return r.expiresAt && r.expiresAt <= now ? "The copy key expired. Approve a new one in copy setup." : "The copy key is no longer registered on SoDEX (revoked or replaced). Approve a new one in copy setup.";
      }
      return null;
    }
    if (k.expiresAt && k.expiresAt <= now) return "The copy key expired. Approve a new one in copy setup.";
    return null;
  }
  signer(owner) {
    const hit = this.signers.get(owner);
    if (hit) return hit;
    const k = this.db.key(owner, "active");
    if (!k || !k.registered) return null;
    try {
      const ref = this.secrets.open(this.cfg.network, owner, k.address, k.sealed, { name: k.name, expiresAt: k.expiresAt });
      this.signers.set(owner, ref);
      return ref;
    } catch (e) {
      this.deps.log.error("copy key could not be opened", { owner, error: String(e) });
      return null;
    }
  }
  sinkFor(s) {
    if (s.settings.paper) return this.paper;
    if (!this.db.key(s.owner, "active")) return null;
    return new KeySink(this.sodex, () => this.signer(s.owner), this.nonces, SODEX_CHAIN_ID[this.cfg.network]);
  }
  /* ----------------------------------------------------------- copies ----- */
  needTerms(owner, ctx) {
    const t = this.db.terms(owner);
    if (!t || t.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(412, "terms", "Accept the copy trading terms first.");
    const policy = regionPolicy(t.country, ctx.viewerCountry);
    if (!policy.allowed) throw new ApiError(451, "region", policy.reason ?? "Copy trading is not available in your region.");
  }
  async subscribe(req, ctx) {
    const { owner, payload, consent } = this.accept(req, "subscribe", ctx);
    if (this.cfg.kind === "hosted" && !this.cfg.open) throw new ApiError(503, "closed", "The ValueDesk executor takes no new copies right now. Running copies continue.");
    this.needTerms(owner, ctx);
    if (payload.termsVersion !== COPY_TERMS_VERSION) throw new ApiError(400, "terms-version", "Reload the page: the copy terms changed.");
    let settings;
    try {
      settings = parseSettings(payload.settings);
    } catch (e) {
      throw new ApiError(400, "settings", e instanceof SettingsError ? e.message : String(e));
    }
    const running = this.runtime.list(owner).filter((s) => s.status !== "stopped");
    if (running.length >= this.cfg.maxCopiesPerOwner) throw new ApiError(429, "limit", `At most ${this.cfg.maxCopiesPerOwner} copies run at once. Stop one first.`);
    if (running.some((s) => s.settings.leader.address === settings.leader.address && s.settings.leader.venue === settings.leader.venue && s.settings.paper === settings.paper)) {
      throw new ApiError(409, "duplicate", "You already copy this trader here. Change that copy instead.");
    }
    let accountId = 0;
    if (!settings.paper) {
      await this.verifyKey(owner);
      const k = this.db.key(owner, "active");
      if (!k || !k.registered) throw new ApiError(412, "key", 'Register the copy key on SoDEX first (copy setup, "Approve agent").');
      accountId = await this.sodex.accountId(owner);
      if (!accountId) throw new ApiError(412, "account", "This wallet has no SoDEX account yet. Deposit first.");
    }
    const t = this.db.terms(owner);
    const now = Date.now();
    const sub = {
      id: randomId("c"),
      owner,
      accountId,
      mode: this.cfg.kind,
      settings,
      status: "active",
      statusReason: null,
      createdAt: now,
      updatedAt: now,
      startedAt: now,
      country: t.country,
      observedCountry: normaliseCountry(ctx.viewerCountry),
      termsVersion: COPY_TERMS_VERSION,
      consent
    };
    await this.runtime.add(sub);
    this.deps.log.info("copy started", { owner, copy: sub.id, leader: settings.leader.address, venue: settings.leader.venue, paper: settings.paper });
    return this.runtime.view(sub.id);
  }
  async act(req, ctx) {
    const { owner, payload, consent } = this.accept(req, ["update", "pause", "resume", "stop", "stop-all"], ctx);
    const action2 = req.action;
    const mine = (id) => {
      const s = typeof id === "string" ? this.runtime.get(id) : null;
      if (!s || s.owner !== owner) throw new ApiError(404, "copy", "No such copy.");
      return s;
    };
    const fail = (e) => {
      throw e instanceof ApiError ? e : new ApiError(409, "state", e instanceof Error ? e.message : String(e));
    };
    let touched = [];
    if (action2 === "stop-all") {
      touched = await this.runtime.stopAll(owner, { close: payload.close === true }).catch(fail);
    } else {
      const s = mine(payload.id);
      if (action2 === "update") {
        this.needTerms(owner, ctx);
        let settings;
        try {
          settings = parseSettings(payload.settings);
        } catch (e) {
          throw new ApiError(400, "settings", e instanceof SettingsError ? e.message : String(e));
        }
        touched = [await this.runtime.update(s.id, { settings, consent }).catch(fail)];
      } else if (action2 === "pause") touched = [await this.runtime.pause(s.id).catch(fail)];
      else if (action2 === "resume") {
        this.needTerms(owner, ctx);
        touched = [await this.runtime.resume(s.id).catch(fail)];
      } else touched = [await this.runtime.stopCopy(s.id, { close: payload.close === true }).catch(fail)];
    }
    return { copies: touched.map((s) => this.runtime.view(s.id)).filter((v) => v !== null) };
  }
  async activity(owner, subId, q) {
    const s = this.runtime.get(subId);
    if (!s || s.owner !== owner) throw new ApiError(404, "copy", "No such copy.");
    return this.db.activity({ subId, limit: q.limit ?? 200, before: q.before });
  }
  /* ------------------------------------------------------------ algos ----- */
  /** The sink of an algo: the key this wallet registered for this executor, the copy fee ladder as the builder. */
  algoSink(a) {
    if (!this.db.key(a.owner, "active")) return null;
    return new KeyAlgoSink(
      this.sodex,
      () => this.signer(a.owner),
      this.nonces,
      SODEX_CHAIN_ID[this.cfg.network],
      async (x) => this.cfg.builderId > 0 ? { id: this.cfg.builderId, fee: copyFeeFor(this.volumeOf(x.owner)) } : null
    );
  }
  /**
   * Why a live algo cannot trade now (it waits, and goes on by itself once
   * this clears): the key and the builder approval, as for a copy. The region
   * rules (blocked countries, the EEA 2x ceiling on leverage and exposure) are
   * applied by the runtime through `policyFor`.
   */
  async algoProblem(a) {
    const key2 = await this.keyProblem(a.owner);
    if (key2) return key2;
    if (this.cfg.builderId > 0) {
      const fee = copyFeeFor(this.volumeOf(a.owner));
      const approved = await this.sodex.builderApproval(a.owner, this.cfg.builderId);
      if (approved === null || approved < fee) return `Your SoDEX account does not approve the ValueDesk fee (${fee / 10} bp) these orders carry. Approve it in copy setup.`;
    }
    return null;
  }
  /** Start an algo order for the wallet that signed it. */
  async algoStart(req, ctx) {
    const { owner, payload, consent } = this.accept(req, "algo-start", ctx);
    if (this.cfg.kind === "hosted" && !this.cfg.open) throw new ApiError(503, "closed", "The ValueDesk executor takes no new orders right now. Running ones continue.");
    this.needTerms(owner, ctx);
    let spec;
    try {
      spec = parseAlgoSpec(payload.spec);
    } catch (e) {
      throw new ApiError(400, "spec", e instanceof AlgoSpecError ? e.message : String(e));
    }
    const seed = Number(payload.seed);
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 4294967295) throw new ApiError(400, "seed", "seed must be a 32-bit whole number.");
    const live = this.algos.list(owner).filter((a2) => !FINAL_STATUSES.has(a2.status));
    if (live.length >= this.cfg.maxAlgosPerOwner) throw new ApiError(429, "limit", `At most ${this.cfg.maxAlgosPerOwner} algo orders run at once here. Cancel one first.`);
    let accountId = 0;
    if (!spec.paper) {
      await this.verifyKey(owner);
      const k = this.db.key(owner, "active");
      if (!k || !k.registered) throw new ApiError(412, "key", `Register this executor's key on SoDEX first (copy setup, "Approve agent").`);
      accountId = await this.sodex.accountId(owner);
      if (!accountId) throw new ApiError(412, "account", "This wallet has no SoDEX account yet. Deposit first.");
    }
    let a;
    try {
      const t = this.db.terms(owner);
      a = await this.algos.add({ owner, accountId, mode: this.cfg.kind, spec, consent, seed, country: t?.country ?? null, observedCountry: normaliseCountry(ctx.viewerCountry) });
    } catch (e) {
      throw new ApiError(400, "algo", e instanceof Error ? e.message : String(e));
    }
    this.deps.log.info("algo started", { owner, algo: a.id, kind: spec.kind, symbol: spec.symbol, paper: spec.paper });
    return this.algos.view(a.id);
  }
  /** Pause, resume or cancel one of the wallet's algos, or cancel all of them (the kill switch). */
  async algoAct(req, ctx) {
    const { owner, payload } = this.accept(req, "algo-action", ctx);
    const op = payload.op;
    const fail = (e) => {
      throw e instanceof ApiError ? e : new ApiError(409, "state", e instanceof Error ? e.message : String(e));
    };
    let touched;
    if (op === "cancel-all") touched = await this.algos.cancelAll(owner).catch(fail);
    else {
      const a = typeof payload.id === "string" ? this.algos.get(payload.id) : null;
      if (!a || a.owner !== owner) throw new ApiError(404, "algo", "No such algo order.");
      if (op === "pause") touched = [await this.algos.pause(a.id).catch(fail)];
      else if (op === "resume") {
        this.needTerms(owner, ctx);
        touched = [await this.algos.resume(a.id).catch(fail)];
      } else if (op === "cancel") touched = [await this.algos.cancel(a.id).catch(fail)];
      else throw new ApiError(400, "op", "op must be pause, resume, cancel or cancel-all.");
    }
    return { algos: touched.map((a) => this.algos.view(a.id)).filter((v) => v !== null) };
  }
  algoList(owner) {
    return this.algos.list(owner).map((a) => this.algos.view(a.id)).filter((v) => v !== null);
  }
  async algoEvents(owner, id, q) {
    const a = this.algos.get(id);
    if (!a || a.owner !== owner) throw new ApiError(404, "algo", "No such algo order.");
    return this.algos.events(id, { limit: q.limit ?? 200, before: q.before });
  }
  /** Every signed instruction of this wallet (newest first): the follower's own record. */
  consents(owner) {
    return this.db.consents(owner).map((c) => ({ action: c.action, payload: c.payload, at: c.at, digest: c.digest }));
  }
  /* ------------------------------------------------------------ volume ----- */
  /** The follower's verified 14-day volume, USD, from the builder ledger on this server (null: not known). */
  volumeOf(owner) {
    if (!this.cfg.builderDb || !this.cfg.builderId) return null;
    const hit = this.volumes.get(owner);
    if (hit && Date.now() - hit.at < 10 * 6e4) return hit.usd;
    let usd = null;
    try {
      if (!this.builderDb) {
        if (!existsSync2(this.cfg.builderDb)) return null;
        this.builderDb = new DatabaseSync2(this.cfg.builderDb, { readOnly: true });
        this.builderDb.exec("PRAGMA busy_timeout = 2000");
      }
      const fromDay = Math.floor(Date.now() / 864e5) - (COPY_FEE_WINDOW_DAYS - 1);
      const r = this.builderDb.prepare("SELECT sum(micro) AS m FROM days WHERE builder = ? AND address = ? AND day >= ?").get(this.cfg.builderId, owner, fromDay);
      usd = r && typeof r.m === "number" ? r.m / 1e6 : 0;
    } catch (e) {
      this.deps.log.warn("copy fee: the builder ledger could not be read", { error: String(e) });
    }
    this.volumes.set(owner, { usd, at: Date.now() });
    return usd;
  }
};

// apps/executor/src/server.ts
var BODY_LIMIT = 64 * 1024;
var PREFIX = "/api/copy/v1";
var Limiter = class {
  constructor(perMinute) {
    this.perMinute = perMinute;
  }
  perMinute;
  hits = /* @__PURE__ */ new Map();
  allow(key2, now = Date.now()) {
    let h = this.hits.get(key2);
    if (!h || now >= h.reset) {
      h = { n: 0, reset: now + 6e4 };
      this.hits.set(key2, h);
      if (this.hits.size > 5e4) {
        for (const [k, v] of this.hits) if (now >= v.reset) this.hits.delete(k);
      }
    }
    return ++h.n <= this.perMinute;
  }
};
function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual2(x, y);
}
async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > BODY_LIMIT) throw new ApiError(413, "too-large", "The request is too large.");
    chunks.push(c);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new ApiError(400, "json", "The body is not JSON.");
  }
}
function createExecutorServer(svc, cfg, log) {
  const reads = new Limiter(240);
  const writes = new Limiter(40);
  const clientOf = (req) => {
    if (cfg.trustEdge) {
      const xff = String(req.headers["x-forwarded-for"] ?? "").split(",")[0]?.trim();
      if (xff) return xff;
    }
    return req.socket.remoteAddress ?? "unknown";
  };
  const contextOf = (req) => ({
    viewerCountry: cfg.trustEdge ? normaliseCountry(String(req.headers["x-viewer-country"] ?? "")) : null,
    pairingCode: typeof req.headers["x-pairing-code"] === "string" ? req.headers["x-pairing-code"] : null
  });
  const cors = (req, res) => {
    const origin = req.headers.origin;
    if (origin && cfg.allowedOrigins.includes(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Pairing-Code");
      res.setHeader("Access-Control-Max-Age", "600");
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
    }
  };
  const send = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Length": Buffer.byteLength(text)
    });
    res.end(text);
  };
  const bearer = (req) => {
    const h = req.headers.authorization;
    return typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : null;
  };
  return createServer(async (req, res) => {
    const t0 = Date.now();
    const url = new URL(req.url ?? "/", "http://executor");
    const path = url.pathname;
    try {
      cors(req, res);
      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
      if (cfg.originSecrets.length && path !== `${PREFIX}/health`) {
        const v = String(req.headers["x-origin-verify"] ?? "");
        if (!cfg.originSecrets.some((s) => safeEqual(s, v))) throw new ApiError(403, "origin", "forbidden");
      }
      if (!path.startsWith(PREFIX)) throw new ApiError(404, "path", "not found");
      const client = clientOf(req);
      const isWrite = req.method === "POST";
      if (!(isWrite ? writes : reads).allow(client)) throw new ApiError(429, "rate", "Too many requests; try again in a minute.");
      const ctx = contextOf(req);
      const route = path.slice(PREFIX.length);
      if (req.method === "GET" && route === "/info") return send(res, 200, svc.info(ctx));
      if (req.method === "GET" && route === "/health") return send(res, 200, svc.health());
      if (req.method === "GET" && route === "/me") return send(res, 200, svc.me(svc.authenticate(bearer(req)), ctx));
      if (req.method === "GET" && route === "/consents") return send(res, 200, { consents: svc.consents(svc.authenticate(bearer(req))) });
      if (req.method === "GET" && route === "/algos") return send(res, 200, { algos: svc.algoList(svc.authenticate(bearer(req))) });
      const algoEv = /^\/algos\/([A-Za-z0-9_-]{1,40})\/events$/.exec(route);
      if (req.method === "GET" && algoEv) {
        const owner = svc.authenticate(bearer(req));
        const before = url.searchParams.get("before");
        return send(res, 200, { events: await svc.algoEvents(owner, algoEv[1], { limit: Number(url.searchParams.get("limit") ?? 200), before: before ? Number(before) : void 0 }) });
      }
      const act2 = /^\/copies\/([A-Za-z0-9_-]{1,40})\/activity$/.exec(route);
      if (req.method === "GET" && act2) {
        const owner = svc.authenticate(bearer(req));
        const limit = Number(url.searchParams.get("limit") ?? 200);
        const before = url.searchParams.get("before");
        return send(res, 200, { entries: await svc.activity(owner, act2[1], { limit, before: before ? Number(before) : void 0 }) });
      }
      if (!isWrite) throw new ApiError(404, "path", "not found");
      const body = await readJson(req);
      if (route === "/session") return send(res, 200, svc.session(body.request, ctx));
      if (route === "/terms") return send(res, 200, svc.acceptTerms(body.request, ctx));
      if (route === "/keys") return send(res, 200, svc.createKey(body.request, ctx));
      if (route === "/keys/verify") return send(res, 200, { key: await svc.verifyKey(svc.authenticate(bearer(req))) });
      if (route === "/keys/delete") return send(res, 200, await svc.deleteKey(body.request, ctx));
      if (route === "/copies") return send(res, 200, await svc.subscribe(body.request, ctx));
      if (route === "/copies/action") return send(res, 200, await svc.act(body.request, ctx));
      if (route === "/algos") return send(res, 200, await svc.algoStart(body.request, ctx));
      if (route === "/algos/action") return send(res, 200, await svc.algoAct(body.request, ctx));
      throw new ApiError(404, "path", "not found");
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(500, "internal", "Something went wrong in the executor.");
      if (!(e instanceof ApiError)) log.error("executor: request failed", { path, error: String(e) });
      send(res, err.status, { ok: false, code: err.code, error: err.message });
    } finally {
      if (path !== `${PREFIX}/health`) log.debug("request", { method: req.method, path, ms: Date.now() - t0, status: res.statusCode });
    }
  });
}

// apps/executor/src/main.ts
var LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
function logger(level) {
  const at = LEVELS[level];
  const out = (l) => (msg, data) => {
    if (LEVELS[l] < at) return;
    const line = JSON.stringify({ t: (/* @__PURE__ */ new Date()).toISOString(), level: l, msg, ...data ?? {} });
    (l === "error" || l === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return { debug: out("debug"), info: out("info"), warn: out("warn"), error: out("error") };
}
async function main() {
  const cfg = loadConfig();
  const log = logger(cfg.logLevel);
  if (typeof globalThis.WebSocket !== "function") {
    throw new Error("This Node.js has no WebSocket; use Node 22 or newer.");
  }
  const db = new ExecutorDb(join3(cfg.dataDir, "executor.db"));
  const secrets = new Secrets(cfg.dataDir);
  const out = egress(cfg.localAddress);
  const svc = new ExecutorService(cfg, db, secrets, { fetch: out.fetch, factory: out.factory, log });
  await svc.start();
  const server = createExecutorServer(svc, cfg, log);
  await new Promise((resolve2, reject) => {
    server.once("error", reject);
    server.listen(cfg.port, cfg.host, () => resolve2());
  });
  log.info("executor up", { kind: cfg.kind, id: svc.executorId, network: cfg.network, listen: `${cfg.host}:${cfg.port}`, data: cfg.dataDir, egress: out.localAddress ?? "default route" });
  if (cfg.kind === "self") {
    const owner = svc.owner();
    const lines = owner ? [`ValueDesk copier for ${owner} is running on http://${cfg.host}:${cfg.port}.`, "In ValueDesk: Copy -> Set up -> Self-hosted, and enter that address."] : [
      `ValueDesk copier is running on http://${cfg.host}:${cfg.port}.`,
      "In ValueDesk: Copy -> Set up -> Self-hosted, enter that address and this pairing code:",
      "",
      `    ${svc.pairingCode}`,
      "",
      "The first wallet that signs in with the code is the only one this copier will ever serve."
    ];
    process.stdout.write(`
${lines.join("\n")}

`);
  }
  const prune = setInterval(() => {
    try {
      const n = db.pruneActivity(Number(process.env.EXECUTOR_ACTIVITY_DAYS ?? 365));
      if (n) log.info("activity pruned", { rows: n });
    } catch (e) {
      log.warn("activity prune failed", { error: String(e) });
    }
  }, 6 * 60 * 6e4);
  prune.unref();
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    log.info("executor stopping", { signal });
    server.close();
    await svc.stop().catch((e) => log.error("stop failed", { error: String(e) }));
    db.close();
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}
main().catch((e) => {
  process.stderr.write(`executor failed to start: ${e instanceof Error ? e.message : String(e)}
`);
  process.exit(1);
});
