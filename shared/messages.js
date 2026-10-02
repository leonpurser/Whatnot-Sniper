// Message types between the side panel and the content script (over a
// chrome.runtime Port), and content script -> service worker.
(function (g) {
  'use strict';
  const WBA = (g.WBA = g.WBA || {});

  WBA.MSG = Object.freeze({
    // panel -> content requests ({ id, type, args } -> { replyTo, ok, result | error })
    GET_SNAPSHOT: 'getSnapshot',
    SET_RECORDING: 'setRecording',
    CLEAR_CAPTURE: 'clearCapture',
    EXPORT_CAPTURE: 'exportCapture',
    LIST_FIELDS: 'listFields',
    SEARCH_CAPTURE: 'searchCapture',
    DOM_SCAN: 'domScan',
    REACT_PROBE: 'reactProbe',
    PICK_ELEMENT: 'pickElement',
    GLOBALS_PROBE: 'globalsProbe',
    ADD_MARKER: 'addMarker',
    BID_NOW: 'bidNow',
    ARM: 'arm',
    DISARM: 'disarm',

    // content -> panel pushes ({ type: 'push', topic, data })
    PUSH: 'push',
    TOPIC_SNAPSHOT: 'snapshot',
    TOPIC_LOG: 'log',
    TOPIC_PICK: 'pick',

    // content -> service worker
    BADGE: 'badge',
  });
})(globalThis);
