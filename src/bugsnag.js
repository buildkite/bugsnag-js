//
// **Bugsnag.js** is the official JavaScript notifier for
// [Bugsnag](https://bugsnag.com).
//
// Bugsnag gives you instant notification of errors and
// exceptions in your website's JavaScript code.
//
// Bugsnag.js is incredibly small, and has no external dependencies (not even
// jQuery!) so you can safely use it on any website.
//

// The `Bugsnag` object is the only globally exported variable
(function (window, old) {
  var QUEUE_STORAGE_KEY = "bugsnag.queue";

  var self = {},
    lastEvent,
    lastScript,
    previousNotification,
    shouldCatch = true,
    ignoreOnError = 0,
    breadcrumbs = [],

    // We've seen cases where individual clients can infinite loop sending us errors
    // (in some cases 10,000+ errors per page). This limit is at the point where
    // you've probably learned everything useful there is to debug the problem,
    // and we're happy to under-estimate the count to save the client (and Bugsnag's) resources.
    eventsRemaining = 10,
    // The default depth of attached metadata which is parsed before truncation. It
    // is configurable via the `maxDepth` setting.
    maxPayloadDepth = 5,

    // If the user loses connectivity with the internet, events are stored here so we can
    // attempt to re-send them when/if they regain connectivity.
    requestQueue = [],

    // helper function for relative times
    millisecondsAgo = makeMillisecondsAgo();

  // #### Bugsnag.noConflict
  //
  // This is obsolete with UMD, as we cannot assume the global scope is polluted with
  // the Bugsnag object anyway. In this case, it's up to the host Javascript file to
  // correctly utilise this functionality.
  //
  // Maybe it's worth removing all together, if we're loading via any UMD method.
  self.noConflict = function() {
    window.Bugsnag = old;
    if (typeof old === "undefined") {
      delete window.Bugsnag;
    }
    return self;
  };

  // ### Bugsnag.refresh
  //
  // Resets the Bugsnag rate limit. If you have a large single-page app, you may
  // wish to call this in your router to avoid exception reports being thrown
  // away.
  //
  // By default Bugsnag aggressively limits the number of exception reports from
  // one page load. This protects both the client's browser and our servers in
  // cases where exceptions are thrown in tight loops or scroll handlers.
  self.refresh = function() {
    eventsRemaining = 10;
  };

  //
  // ### Manual error notification (public methods)
  //

  // #### Bugsnag.notifyException
  //
  // Notify Bugsnag about a given `exception`, typically that you've caught
  // with a `try/catch` statement or that you've generated yourself.
  //
  // It's almost always better to let an exception bubble rather than catching
  // it, as that gives more consistent behaviour across browsers. Consider
  // re-throwing instead of calling .notifyException.
  //
  // Since most JavaScript exceptions use the `Error` class, we also allow
  // you to provide a custom error name when calling `notifyException`.
  //
  // The default value is "warning" and "error" and "info" are also supported by the
  // backend, all other values cause the notification to be dropped; and you
  // will not see it in your dashboard.
  self.notifyException = function (exception, name, metaData, severity) {
    if (!exception) {
      return;
    }
    if (name && typeof name !== "string") {
      metaData = name;
      name = undefined;
    }
    if (!metaData) {
      metaData = {};
    }
    addScriptToMetaData(metaData);

    sendToBugsnag({
      name: name || exception.name,
      message: exception.message || exception.description,
      stacktrace: stacktraceFromException(exception) || generateStacktrace(),
      file: exception.fileName || exception.sourceURL,
      lineNumber: exception.lineNumber || exception.line,
      columnNumber: exception.columnNumber ? exception.columnNumber + 1 : undefined,
      severity: severity || "warning"
    }, metaData);
  };

  // #### Bugsnag.notify
  //
  // Notify Bugsnag about an error by passing in a `name` and `message`,
  // without requiring an exception.
  self.notify = function (name, message, metaData, severity) {
    sendToBugsnag({
      name: name,
      message: message,
      stacktrace: generateStacktrace(),
      // These are defaults so that 'bugsnag.notify()' calls show up in old IE,
      // newer browsers get a legit stacktrace from generateStacktrace().
      file: window.location.toString(),
      lineNumber: 1,
      severity: severity || "warning"
    }, metaData);
  };

  // #### Bugsnag.leaveBreadcrumb(value, [metaData])
  //
  // Add a breadcrumb to the array of breadcrumbs to be sent to Bugsnag when the next exception occurs
  // - `value` (string|object) If this is an object, it will be used as the entire breadcrumb object
  //   and any missing `type`, `name` or `timestamp` fields will get default values.
  //   if this is a string and metaData is provided, then `value` will be used as the `name` of the
  //   breadcrumb.
  //   if `value` is a string and is the only argument the breadcrumb will have `manual` type and
  //   the value will be used as the `message` field of `metaData`.
  //
  // - `metadata` (optional, object) - Additional information about the breadcrumb. Values limited to 140 characters.
  self.leaveBreadcrumb = function(value, metaData) {
    // default crumb
    var crumb = {
      type: "manual",
      name: "Manual",
      timestamp: new Date().getTime()
    };

    switch (typeof value) {
    case "object":
      crumb = merge(crumb, value);
      break;
    case "string":
      if (metaData && typeof metaData === "object") {
        crumb = merge(crumb, {
          name: value,
          metaData: metaData
        });
      } else {
        crumb.metaData = { message: value };
      }
      break;
    default:
      log("expecting 1st argument to leaveBreadcrumb to be a 'string' or 'object', got " + typeof value);
      return;
    }

    var lastCrumb = breadcrumbs.slice(-1)[0];
    if (breadcrumbsAreEqual(crumb, lastCrumb)) {
      lastCrumb.count = lastCrumb.count || 1;
      lastCrumb.count++;
    } else {
      crumb.name = truncate(crumb.name, 32);
      breadcrumbs.push(truncateDeep(crumb, 140));
    }
  };

  function breadcrumbsAreEqual(crumb1, crumb2) {
    return crumb1 && crumb2 &&
      crumb1.type === crumb2.type &&
      crumb1.name === crumb2.name &&
      isEqual(crumb1.metaData, crumb2.metaData);
  }

  // Return a function acts like the given function, but reports
  // any exceptions to Bugsnag before re-throwing them.
  //
  // This is not a public function because it can only be used if
  // the exception is not caught after being thrown out of this function.
  //
  // If you call wrap twice on the same function, it'll give you back the
  // same wrapped function. This lets removeEventListener to continue to
  // work.
  function wrap(_super, options) {
    try {
      if (typeof _super !== "function") {
        return _super;
      }
      if (!_super.bugsnag) {
        var currentScript = getCurrentScript();
        _super.bugsnag = function (event) {
          if (options && options.eventHandler) {
            lastEvent = event;
          }
          lastScript = currentScript;

          // We set shouldCatch to false on IE < 10 because catching the error ruins the file/line as reported in window.onerror,
          // We set shouldCatch to false on Chrome/Safari because it interferes with "break on unhandled exception"
          // All other browsers need shouldCatch to be true, as they don't pass the exception object to window.onerror
          if (shouldCatch) {
            try {
              return _super.apply(this, arguments);
            } catch (e) {
              // We do this rather than stashing treating the error like lastEvent
              // because in FF 26 onerror is not called for synthesized event handlers.
              if (getSetting("autoNotify", true)) {
                self.notifyException(e, null, null, "error");
                ignoreNextOnError();
              }
              throw e;
            } finally {
              lastScript = null;
            }
          } else {
            var ret = _super.apply(this, arguments);
            // in case of error, this is set to null in window.onerror
            lastScript = null;
            return ret;
          }
        };
        _super.bugsnag.bugsnag = _super.bugsnag;
      }
      return _super.bugsnag;

    // This can happen if _super is not a normal javascript function.
    // For example, see https://github.com/bugsnag/bugsnag-js/issues/28
    } catch (e) {
      return _super;
    }
  }

  // Prevents a function from being invoked more than once.
  function once(callback) {
    var called = false;
    return function () {
      if (!called) {
        called = true;
        return callback.apply(this, arguments);
      }
    };
  }

  // Ponyfill for registering event listeners.
  var addEvent = (function () {
    if (window.addEventListener) {
      return function (el, event, callback, capture) {
        el.addEventListener(event, callback, capture);
      };
    } else if (window.attachEvent) {
      return function (el, event, callback) {
        el.attachEvent("on" + event, callback);
      };
    }
  })();

  // Setup breadcrumbs for click events
  function trackClicks() {
    if(!getBreadcrumbSetting("autoBreadcrumbsClicks", true)) {
      return;
    }

    var callback = function(event) {
      self.leaveBreadcrumb({
        type: "user",
        name: "UI click",
        metaData: {
          targetText: nodeText(event.target),
          targetSelector: nodeLabel(event.target)
        }
      });
    };

    addEvent(window, "click", callback, true);
  }

  // Setup breadcrumbs for console.log, console.warn, console.error
  function trackConsoleLog(){
    if(!window.console || typeof window.console.log !== "function" || !getBreadcrumbSetting("autoBreadcrumbsConsole")) {
      return;
    }

    function trackLog(severity, args) {
      self.leaveBreadcrumb({
        type: "log",
        name: "Console output",
        metaData: {
          severity: severity,
          message: Array.prototype.slice.call(args).join(", ")
        }
      });
    }

    enhance(console, "log", function() {
      trackLog("log", arguments);
    });

    enhance(console, "warn", function() {
      trackLog("warn", arguments);
    });

    enhance(console, "error", function() {
      trackLog("error", arguments);
    });
  }

  // Setup breadcrumbs for history navigation events
  function trackNavigation() {
    if(!getBreadcrumbSetting("autoBreadcrumbsNavigation")) {
      return;
    }

    // check for browser support
    if (!window.history ||
        !window.history.state ||
        !window.history.pushState ||
        !window.history.pushState.bind
    ) {
      return;
    }

    function parseHash(url) {
      return url.split("#")[1] || "";
    }

    function buildHashChange(event) {
      var oldURL = event.oldURL,
        newURL = event.newURL,
        metaData = {};

      // not supported in old browsers
      if (oldURL && newURL) {
        metaData.from = parseHash(oldURL);
        metaData.to = parseHash(newURL);
      } else {
        metaData.to = location.hash;
      }

      return {
        type: "navigation",
        name: "Hash changed",
        metaData: metaData
      };
    }

    function buildPopState() {
      return {
        type: "navigation",
        name: "Navigated back"
      };
    }

    function buildPageHide() {
      return {
        type: "navigation",
        name: "Page hidden"
      };
    }

    function buildPageShow() {
      return {
        type: "navigation",
        name: "Page shown"
      };
    }

    function buildLoad() {
      return {
        type: "navigation",
        name: "Page loaded"
      };
    }

    function buildDOMContentLoaded() {
      return {
        type: "navigation",
        name: "DOMContentLoaded"
      };
    }

    function buildStateChange(name, state, title, url) {
      var currentPath = location.pathname + location.search + location.hash;
      return {
        type: "navigation",
        name: "History " + name,
        metaData: {
          from: currentPath,
          to: url || currentPath,
          prevState: history.state,
          nextState: state
        }
      };
    }

    function buildPushState(state, title, url) {
      return buildStateChange("pushState", state, title, url);
    }

    function buildReplaceState(state, title, url) {
      return buildStateChange("replaceState", state, title, url);
    }

    // functional fu to make it easier to setup event listeners
    function wrapBuilder(builder) {
      return function() {
        self.leaveBreadcrumb(builder.apply(null, arguments));
      };
    }

    addEvent(window, "hashchange", wrapBuilder(buildHashChange), true);
    addEvent(window, "popstate", wrapBuilder(buildPopState), true);
    addEvent(window, "pagehide", wrapBuilder(buildPageHide), true);
    addEvent(window, "pageshow", wrapBuilder(buildPageShow), true);
    addEvent(window, "load", wrapBuilder(buildLoad), true);
    addEvent(window, "DOMContentLoaded", wrapBuilder(buildDOMContentLoaded), true);

    // create hooks for pushstate and replaceState
    enhance(history, "pushState", wrapBuilder(buildPushState));
    enhance(history, "replaceState", wrapBuilder(buildReplaceState));
  }

  //
  // ### Script tag tracking
  //

  // To emulate document.currentScript we use document.scripts.last.
  // This only works while synchronous scripts are running, so we track
  // that here.
  var synchronousScriptsRunning = document.readyState !== "complete";
  var loadCompleted = once(function loadCompleted() {
    synchronousScriptsRunning = false;

    // At this point we can load any previously queued requests from storage
    // and attempt to send them again.
    loadRequestQueueFromStorage();
    processQueuedRequests();

    // Trigger retrying any in-memory request payloads
    addEvent(window, "online", processQueuedRequests);
  });

  // from jQuery. We don't have quite such tight bounds as they do if
  // we end up on the window.onload event as we don't try and hack
  // the .scrollLeft() fix in because it doesn't work in frames so
  // we'd need these fallbacks anyway.
  // The worst that can happen is we group an event handler that fires
  // before us into the last script tag.
  addEvent(document, "DOMContentLoaded", loadCompleted, true);
  addEvent(window, "load", loadCompleted, true);

  function getCurrentScript() {
    var script = document.currentScript || lastScript;

    if (!script && synchronousScriptsRunning) {
      var scripts = document.scripts || document.getElementsByTagName("script");
      script = scripts[scripts.length - 1];
    }

    return script;
  }

  function addScriptToMetaData(metaData) {
    var script = getCurrentScript();

    if (script) {
      metaData.script = {
        src: script.src,
        content: getSetting("inlineScript", true) ? script.innerHTML : ""
      };
    }
  }

  //
  // ### Helpers & Setup
  //

  // Compile regular expressions upfront.
  var API_KEY_REGEX = /^[0-9a-f]{32}$/i;
  var FUNCTION_REGEX = /function\s*([\w\-$]+)?\s*\(/i;

  // Set up default notifier settings.
  var DEFAULT_BASE_ENDPOINT = "https://notify.bugsnag.com/";
  var DEFAULT_NOTIFIER_ENDPOINT = DEFAULT_BASE_ENDPOINT + "js";
  var NOTIFIER_VERSION = "3.0.0-rc.1";

  // Keep a reference to the currently executing script in the DOM.
  // We'll use this later to extract settings from attributes.
  var scripts = document.getElementsByTagName("script");
  var thisScript = scripts[scripts.length - 1];

  // Replace existing function on object with custom one, but still call the original afterwards
  // example:
  //  enhance(console, 'log', function() {
  //    /* custom behavior */
  //  })
  function enhance(object, property, newFunction) {
    var oldFunction = object[property];
    if (typeof oldFunction === "function") {
      object[property] = function() {
        newFunction.apply(this, arguments);
        oldFunction.apply(this, arguments);
      };
    }
  }

  // Simple logging function that wraps `console.log` if available.
  // This is useful for warning about configuration issues
  // eg. forgetting to set an API key.
  function log(msg) {
    var disableLog = getSetting("disableLog");

    var console = window.console;
    if (console !== undefined && console.log !== undefined && !disableLog) {
      console.log("[Bugsnag] " + msg);
    }
  }

  // Compare if two objects are equal.
  function isEqual(obj1, obj2) {
    return serialize(obj1) === serialize(obj2);
  }

  // extract text content from a element
  function nodeText(el) {
    var text = el.textContent || el.innerText;
    return truncate(text, 40);
  }

  // Create a label from tagname, id and css class of the element
  function nodeLabel(el) {
    var parts = [el.tagName];

    if (el.id) {
      parts.push("#" + el.id);
    }

    if (el.className && el.className.length) {
      var classString = "." + el.className.split(" ").join(".");
      classString = truncate(classString, 40);
      parts.push(classString);
    }

    return parts.join("");
  }

  function truncate(value, length) {
    var OMISSION = "(...)";

    if (value && value.length > length) {
      return value.slice(0, length - OMISSION.length) + OMISSION;
    } else {
      return value;
    }
  }

  // truncate all string values in nested object
  function truncateDeep(object, length) {
    if (typeof object === "object") {
      var newObject = {};
      each(object, function(value, key){
        if (value != null && value !== undefined) {
          newObject[key] = truncateDeep(value, length);
        }
      });

      return newObject;
    } else if (typeof object === "string") {
      return truncate(object, length);
    } else if (object && Array === object.constructor) {
      return map(object, function(value) { return truncateDeep(value, length); });
    } else {
      return object;
    }
  }

  // Deeply serialize an object into a query string. We use the PHP-style
  // nested object syntax, `nested[keys]=val`, to support heirachical
  // objects. Similar to jQuery's `$.param` method.
  function serialize(obj, prefix, depth) {
    var maxDepth = getSetting("maxDepth", maxPayloadDepth);

    if (depth >= maxDepth) {
      return encodeURIComponent(prefix) + "=[RECURSIVE]";
    }
    depth = depth + 1 || 1;

    try {
      if (window.Node && obj instanceof window.Node) {
        return encodeURIComponent(prefix) + "=" + encodeURIComponent(targetToString(obj));
      }

      var str = [];
      for (var p in obj) {
        if (obj.hasOwnProperty(p) && p != null && obj[p] != null) {
          var k = prefix ? prefix + "[" + p + "]" : p, v = obj[p];
          str.push(typeof v === "object" ? serialize(v, k, depth) : encodeURIComponent(k) + "=" + encodeURIComponent(v));
        }
      }
      return str.sort().join("&");
    } catch (e) {
      return encodeURIComponent(prefix) + "=" + encodeURIComponent("" + e);
    }
  }


  // Map over an array or object
  // re-implementation of lodash map
  function map(source, iteratee) {
    if (typeof iteratee === "undefined") {
      return source;
    }

    var newArray = [];

    each(source, newArray.push);

    return newArray;
  }

  // Iterate over an array or object
  // re-implementation of lodash each
  function each(source, iteratee) {
    if (typeof source === "object") {
      for (var key in source) {
        if (source.hasOwnProperty(key)) {
          iteratee(source[key], key, source);
        }
      }
    } else {
      for (var index = 0; index < source.length; index++) {
        iteratee(source[index], index, source);
      }
    }
  }

  function shallowMerge(target, source) {
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) {
        target[key] = source[key];
      }
    }
    return target;
  }

  // Deep-merge the `source` object into the `target` object and return
  // the `target`. Properties in source that will overwrite those in target.
  // Similar to jQuery's `$.extend` method.
  function merge(target, source, depth) {
    if (source == null) {
      return target;
    } else if (depth >= getSetting("maxDepth", maxPayloadDepth)) {
      return "[RECURSIVE]";
    }

    target = target || {};
    for (var key in source) {
      if (source.hasOwnProperty(key)) {
        try {
          if (source[key].constructor === Object) {
            target[key] = merge(target[key], source[key], depth + 1 || 1);
          } else {
            target[key] = source[key];
          }
        } catch (e) {
          target[key] = source[key];
        }
      }
    }

    return target;
  }

  // Returns whether the browser's online connectivity is active.
  //
  // For browsers without support for the `navigator.onLine` spec, we default to true, and attempt
  // to send the error event anyway.
  function isOnline() {
    return (
      typeof BUGSNAG_TESTING !== "undefined" ||
      (typeof navigator.onLine === "boolean" ? navigator.onLine : true)
    );
  }

  // Invokes a callback when the target has completed a request. Supports images and xhr objects.
  // The callback is invoked with a single argument (of type boolean), which is `true` when there
  // is some form of error with the request.
  function onRequestEnd(target, callback) {
    callback = once(callback);
    function handleOnRequestEndEvent(event) {
      if (event.type === "readystatechange" && target.readyState === 4) {
        callback(target.status !== 200);
      } else {
        callback(target.type === "error");
      }
    }
    target.onreadystatechange = target.onload = target.onerror = handleOnRequestEndEvent;
  }

  // Safely grabs a hold of localStorage (if possible) or returns an empty object if the browser
  // has explicitly disabled it - (Safari errors when local storage is disabled and `localStorage`
  // is accessed.
  function getLocalStorage() {
    var storageType = getSetting("storage", "session") + "Storage";
    try {
      return window[storageType];
    } catch (err) {
      return {};
    }
  }

  function loadRequestQueueFromStorage() {
    var localRequestQueue = getLocalStorage()[QUEUE_STORAGE_KEY];
    if (localRequestQueue) {
      requestQueue = JSON.parse(localRequestQueue);
    }
  }

  function pushRequestToQueue(request) {
    delete request.apiKey;
    requestQueue.push(request);
    updateLocalStorageRequestQueue();
  }

  function updateLocalStorageRequestQueue() {
    var localStorage = getLocalStorage();
    if (requestQueue.length) {
      localStorage[QUEUE_STORAGE_KEY] = JSON.stringify(requestQueue);
    } else {
      delete localStorage[QUEUE_STORAGE_KEY];
    }
  }

  // Make a HTTP request with given `url` and `params` object.
  // For maximum browser compatibility and cross-domain support, requests are
  // made by creating a temporary JavaScript `Image` object.
  // Additionally the request can be done via XHR (needed for Chrome apps and extensions)
  // To set the script to use XHR, you can specify data-notifyhandler attribute in the script tag
  // Eg. `<script data-notifyhandler="xhr">` - the request defaults to image if attribute is not set
  function request(params, callback, isRetry) {
    if (!isOnline()) {
      if (!isRetry) {
        log("Queuing error event due to lack of network connectivity.");
        params.queuedCause = "offline";
        pushRequestToQueue(params);
      }
      return;
    }
    var url = getSetting("endpoint") || DEFAULT_NOTIFIER_ENDPOINT;
    url += "?" + serialize(params) + "&ct=img&cb=" + new Date().getTime();
    if (typeof BUGSNAG_TESTING !== "undefined" && self.testRequest) {
      self.testRequest(url, params);
    } else {
      var notifyHandler = getSetting("notifyHandler");
      var handler;
      if (notifyHandler === "xhr") {
        handler = new XMLHttpRequest();
        handler.open("GET", url, true);
        handler.send();
      } else {
        handler = new Image();
        handler.src = url;
      }
      onRequestEnd(handler, function (err) {
        if (err && !isRetry) {
          params.queuedCause = "failed";
          pushRequestToQueue(params);
          log("Queuing error event due to lack of network connectivity.");
        }
        if (callback) {
          callback(err);
        }
      });
    }
  }

  function processQueuedRequests() {
    var apiKey = getSetting("apiKey");
    if (!validateApiKey(apiKey)) {
      log("Unable to retry previously failed/queued error event(s) due to invalid apiKey.");
      return;
    }
    function next() {
      if (isOnline() && requestQueue.length) {
        var payload = shallowMerge({apiKey: apiKey}, requestQueue[0]);
        request(payload, function (err) {
          if (!err) {
            requestQueue.shift();
            updateLocalStorageRequestQueue();
            next();
          }
        }, true);
      }
    }
    if (requestQueue.length) {
      log("Attempting to retry previously failed/queued error event(s).");
      next();
    }
  }

  // Extract all `data-*` attributes from a DOM element and return them as an
  // object. This is used to allow Bugsnag settings to be set via attributes
  // on the `script` tag, eg. `<script data-apikey="xyz">`.
  // Similar to jQuery's `$(el).data()` method.
  function getData(node) {
    var dataAttrs = {};
    var dataRegex = /^data\-([\w\-]+)$/;

    // If the node doesn't exist due to being loaded as a commonjs module,
    // then return an empty object and fallback to self[].
    if (node) {
      var attrs = node.attributes;
      for (var i = 0; i < attrs.length; i++) {
        var attr = attrs[i];
        if (dataRegex.test(attr.nodeName)) {
          var key = attr.nodeName.match(dataRegex)[1];
          dataAttrs[key] = attr.value || attr.nodeValue;
        }
      }
    }

    return dataAttrs;
  }

  // Get configuration settings from either `self` (the `Bugsnag` object)
  // or `data` (the `data-*` attributes).
  var data;
  function getSetting(name, fallback) {
    data = data || getData(thisScript);
    var setting = self[name] !== undefined ? self[name] : data[name.toLowerCase()];
    if (setting === "false") {
      setting = false;
    }
    return setting !== undefined ? setting : fallback;
  }

  // Validate a Bugsnag API key exists and is of the correct format.
  function validateApiKey(apiKey) {
    if (!apiKey || !apiKey.match(API_KEY_REGEX)) {
      log("Invalid API key '" + apiKey + "'");
      return false;
    }

    return true;
  }

  // get breadcrumb specific setting. When autoBreadcrumbs is true, all individual events are defaulted
  // to true. Otherwise they will all defaul to false. You can set any event specicically and it will override
  // the default.
  function getBreadcrumbSetting(name) {
    var fallback = getSetting("autoBreadcrumbs", true);
    return getSetting(name, fallback);
  }

  // Send an error to Bugsnag.
  function sendToBugsnag(details, metaData) {
    // Validate the configured API key.
    var apiKey = getSetting("apiKey");
    if (!validateApiKey(apiKey) || !eventsRemaining) {
      return;
    }

    eventsRemaining -= 1;

    // Check if we should notify for this release stage.
    var releaseStage = getSetting("releaseStage", "production");
    var notifyReleaseStages = getSetting("notifyReleaseStages");
    if (notifyReleaseStages) {
      var shouldNotify = false;
      for (var i = 0; i < notifyReleaseStages.length; i++) {
        if (releaseStage === notifyReleaseStages[i]) {
          shouldNotify = true;
          break;
        }
      }

      if (!shouldNotify) {
        return;
      }
    }

    // Don't send multiple copies of the same error.
    // This fixes a problem when a client goes into an infinite loop,
    // and starts wasting all their bandwidth sending messages to bugsnag.
    var deduplicate = [details.name, details.message, details.stacktrace].join("|");
    if (deduplicate === previousNotification) {
      return;
    } else {
      previousNotification = deduplicate;
    }

    if (lastEvent) {
      metaData = metaData || {};
      metaData["Last Event"] = eventToMetaData(lastEvent);
    }

    // Build the request payload by combining error information with other data
    // such as user-agent and locale, `metaData` and settings.
    var payload = {
      notifierVersion: NOTIFIER_VERSION,

      apiKey: apiKey,
      projectRoot: getSetting("projectRoot") || window.location.protocol + "//" + window.location.host,
      context: getSetting("context") || window.location.pathname,
      userId: getSetting("userId"), // Deprecated, remove in v3
      user: getSetting("user"),
      metaData: merge(merge({}, getSetting("metaData")), metaData),
      releaseStage: releaseStage,
      appVersion: getSetting("appVersion"),

      url: window.location.href,
      userAgent: navigator.userAgent,
      language: navigator.language || navigator.userLanguage,

      severity: details.severity,

      name: details.name,
      message: details.message,
      stacktrace: details.stacktrace,
      file: details.file,
      lineNumber: details.lineNumber,
      columnNumber: details.columnNumber,
      breadcrumbs: breadcrumbs,
      payloadVersion: "3"
    };

    // Run any `beforeNotify` function
    var beforeNotify = self.beforeNotify;
    if (typeof(beforeNotify) === "function") {
      var retVal = beforeNotify(payload, payload.metaData);
      if (retVal === false) {
        return;
      }
    }

    if (payload.lineNumber === 0 && (/Script error\.?/).test(payload.message)) {
      return log("Ignoring cross-domain script error. See https://bugsnag.com/docs/notifiers/js/cors");
    }

    // Make the HTTP request
    request(payload);
  }

  // Generate a browser stacktrace (or approximation) from the current stack.
  // This is used to add a stacktrace to `Bugsnag.notify` calls, and to add a
  // stacktrace approximation where we can't get one from an exception.
  function generateStacktrace() {
    var generated, stacktrace;
    var MAX_FAKE_STACK_SIZE = 10;
    var ANONYMOUS_FUNCTION_PLACEHOLDER = "[anonymous]";

    // Try to generate a real stacktrace (most browsers, except IE9 and below).
    try {
      throw new Error("");
    } catch (exception) {
      generated = "<generated>\n";
      stacktrace = stacktraceFromException(exception);
    }

    // Otherwise, build a fake stacktrace from the list of method names by
    // looping through the list of functions that called this one (and skip
    // whoever called us).
    if (!stacktrace) {
      generated = "<generated-ie>\n";
      var functionStack = [];
      try {
        var curr = arguments.callee.caller.caller;
        while (curr && functionStack.length < MAX_FAKE_STACK_SIZE) {
          var fn = FUNCTION_REGEX.test(curr.toString()) ? RegExp.$1 || ANONYMOUS_FUNCTION_PLACEHOLDER : ANONYMOUS_FUNCTION_PLACEHOLDER;
          functionStack.push(fn);
          curr = curr.caller;
        }
      } catch (e) {
        log(e);
      }
      stacktrace = functionStack.join("\n");
    }

    // Tell the backend to ignore the first two lines in the stack-trace.
    // generateStacktrace() + window.onerror,
    // generateStacktrace() + notify,
    // generateStacktrace() + notifyException
    return generated + stacktrace;
  }

  // Get the stacktrace string from an exception
  function stacktraceFromException(exception) {
    return exception.stack || exception.backtrace || exception.stacktrace;
  }

  // Populate the event tab of meta-data.
  function eventToMetaData(event) {
    var tab = {
      millisecondsAgo: millisecondsAgo(event.timeStamp),
      type: event.type,
      which: event.which,
      target: targetToString(event.target)
    };

    return tab;
  }

  // Convert a DOM element into a string suitable for passing to Bugsnag.
  function targetToString(target) {
    if (target) {
      var attrs = target.attributes;

      if (attrs) {
        var ret = "<" + target.nodeName.toLowerCase();
        for (var i = 0; i < attrs.length; i++) {
          if (attrs[i].value && attrs[i].value.toString() !== "null") {
            ret += " " + attrs[i].name + "=\"" + attrs[i].value + "\"";
          }
        }
        return ret + ">";
      } else {
         // e.g. #document
        return target.nodeName;
      }
    }
  }

  // If we've notified bugsnag of an exception in wrap, we don't want to
  // re-notify when it hits window.onerror after we re-throw it.
  function ignoreNextOnError() {
    ignoreOnError += 1;
    window.setTimeout(function () {
      ignoreOnError -= 1;
    });
  }

  // Disable catching on IE < 10 as it destroys stack-traces from generateStackTrace()
  if (!window.atob) {
    shouldCatch = false;

  // Disable catching on browsers that support HTML5 ErrorEvents properly.
  // This lets debug on unhandled exceptions work.
  } else if (window.ErrorEvent) {
    try {
      if (new window.ErrorEvent("test").colno === 0) {
        shouldCatch = false;
      }
    } catch(e){ /* No action needed */ }
  }


  //
  // ### Polyfilling
  //

  // Add a polyFill to an object
  function polyFill(obj, name, makeReplacement) {
    var original = obj[name];
    var replacement = makeReplacement(original);
    obj[name] = replacement;

    if (typeof BUGSNAG_TESTING !== "undefined" && window.undo) {
      window.undo.push(function () {
        obj[name] = original;
      });
    }
  }

  if (getSetting("autoNotify", true)) {
    //
    // ### Automatic error notification
    //
    // Attach to `window.onerror` events and notify Bugsnag when they happen.
    // These are mostly js compile/parse errors, but on some browsers all
    // "uncaught" exceptions will fire this event.
    //
    polyFill(window, "onerror", function (_super) {
      // Keep a reference to any existing `window.onerror` handler
      if (typeof BUGSNAG_TESTING !== "undefined") {
        self._onerror = _super;
      }

      return function bugsnag(message, url, lineNo, charNo, exception) {
        var shouldNotify = getSetting("autoNotify", true);
        var metaData = {};

        // IE 6+ support.
        if (!charNo && window.event) {
          charNo = window.event.errorCharacter;
        }

        addScriptToMetaData(metaData);
        lastScript = null;

        if (shouldNotify && !ignoreOnError) {
          var name = exception && exception.name || "window.onerror";
          sendToBugsnag({
            name: name,
            message: message,
            file: url,
            lineNumber: lineNo,
            columnNumber: charNo,
            stacktrace: (exception && stacktraceFromException(exception)) || generateStacktrace(),
            severity: "error"
          }, metaData);

          // add the error to the breadcrumbs
          if (getBreadcrumbSetting("autoBreadcrumbsErrors")) {
            self.leaveBreadcrumb({
              type: "error",
              name: name,
              metaData: {
                severity: "error",
                file: url,
                message: message,
                line: lineNo
              }
            });
          }
        }

        if (typeof BUGSNAG_TESTING !== "undefined") {
          _super = self._onerror;
        }

        // Fire the existing `window.onerror` handler, if one exists
        if (_super) {
          _super(message, url, lineNo, charNo, exception);
        }
      };
    });

    var hijackTimeFunc = function (_super) {
      // Note, we don't do `_super.call` because that doesn't work on IE 8,
      // luckily this is implicitly window so it just works everywhere.
      //
      // setTimout in all browsers except IE <9 allows additional parameters
      // to be passed, so in order to support these without resorting to call/apply
      // we need an extra layer of wrapping.
      return function (f, t) {
        if (typeof f === "function") {
          f = wrap(f);
          var args = Array.prototype.slice.call(arguments, 2);
          return _super(function () {
            f.apply(this, args);
          }, t);
        } else {
          return _super(f, t);
        }
      };
    };

    polyFill(window, "setTimeout", hijackTimeFunc);
    polyFill(window, "setInterval", hijackTimeFunc);

    if (window.requestAnimationFrame) {
      polyFill(window, "requestAnimationFrame", function (_super) {
        return function (callback) {
          return _super(wrap(callback));
        };
      });
    }

    if (window.setImmediate) {
      polyFill(window, "setImmediate", function (_super) {
        return function () {
          var args = Array.prototype.slice.call(arguments);
          args[0] = wrap(args[0]);
          return _super.apply(this, args);
        };
      });
    }

    // EventTarget is all that's required in modern chrome/opera
    // EventTarget + Window + ModalWindow is all that's required in modern FF (there are a few Moz prefixed ones that we're ignoring)
    // The rest is a collection of stuff for Safari and IE 11. (Again ignoring a few MS and WebKit prefixed things)
    "EventTarget Window Node ApplicationCache AudioTrackList ChannelMergerNode CryptoOperation EventSource FileReader HTMLUnknownElement IDBDatabase IDBRequest IDBTransaction KeyOperation MediaController MessagePort ModalWindow Notification SVGElementInstance Screen TextTrack TextTrackCue TextTrackList WebSocket WebSocketWorker Worker XMLHttpRequest XMLHttpRequestEventTarget XMLHttpRequestUpload".replace(/\w+/g, function (global) {
      var prototype = window[global] && window[global].prototype;
      if (prototype && prototype.hasOwnProperty && prototype.hasOwnProperty("addEventListener")) {
        polyFill(prototype, "addEventListener", function (_super) {
          return function (e, f, capture, secure) {
            // HTML lets event-handlers be objects with a handlEvent function,
            // we need to change f.handleEvent here, as self.wrap will ignore f.
            try {
              if (f && f.handleEvent) {
                f.handleEvent = wrap(f.handleEvent, {eventHandler: true});
              }
            } catch (err) {
              // When selenium is installed, we sometimes get 'Permission denied to access property "handleEvent"'
              // Because this catch is around Bugsnag library code, it won't catch any user errors
              log(err);
            }
            return _super.call(this, e, wrap(f, {eventHandler: true}), capture, secure);
          };
        });

        // We also need to hack removeEventListener so that you can remove any
        // event listeners.
        polyFill(prototype, "removeEventListener", function (_super) {
          return function (e, f, capture, secure) {
            _super.call(this, e, f, capture, secure);
            return _super.call(this, e, wrap(f), capture, secure);
          };
        });
      }
    });
  }

  // creates a function that takes a timeStamp and returns the number of milliseconds it happened in
  // the past.
  //
  // This is necessary because depending on the browser the event.timeStamp could be a
  // DOMTimeStamp or a DOMHighResTimeStamp
  function makeMillisecondsAgo() {
    function highRes(timeStamp) {
      return performance.now() - timeStamp;
    }

    function legacy(timeStamp) {
      return new Date() - timeStamp;
    }

    function timeNear(a, b) {
      var d = 1000 * 60 * 5;
      return a > b - d && a < b + d;
    }

    // Old browsers don't support document.createEvent
    var testEvent;
    try {
      testEvent = document.createEvent("CustomEvent");
    } catch(e) {
      return legacy;
    }

    // if the testTimeStamp is close to performance.now() then it is a DOMHighResTimeStamp
    var isHighRes = window.hasOwnProperty("performance")
                     && timeNear(testEvent.timeStamp, window.performance.now());

    return isHighRes ? highRes : legacy;
  }

  // setup auto breadcrumb tracking
  trackClicks();
  trackConsoleLog();
  trackNavigation();

  window.Bugsnag = self;
  // If people are using a javascript loader, we should integrate with it.
  // We don't want to defer instrumenting their code with callbacks however,
  // so we slightly abuse the intent and continue with our plan of polyfilling
  // the browser whether or not they ever actually require the module.
  // This has the nice side-effect of continuing to work when people are using
  // AMD but loading Bugsnag via a CDN.
  // It has the not-so-nice side-effect of polluting the global namespace, but
  // you can easily call Bugsnag.noConflict() to fix that.
  if (typeof define === "function" && define.amd) {
    // AMD
    define([], function () {
      return self;
    });
  } else if (typeof module === "object" && typeof module.exports === "object") {
    // CommonJS/Browserify
    module.exports = self;
  }
})(window, window.Bugsnag);
