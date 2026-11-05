/**
 * 最小但语义贴近真实浏览器的 XMLHttpRequest mock。
 *
 * 关键点：response / responseText 必须定义在 **prototype 上用 accessor**，
 * 否则测不出 getter hook（实例上的数据属性会遮蔽原型上的访问器）。
 */
'use strict';

function XHRMock() {
  this.readyState = 0;
  this.status = 0;
  this.statusText = '';
  this.responseType = '';
  this.withCredentials = false;
  this.upload = { addEventListener: function () {}, removeEventListener: function () {} };
  this._listeners = {};
  this._headers = {};
  this._responseText = '';
  this._url = '';
  this._method = '';
  this._sent = false;
  this._aborted = false;
  this._sentBody = null;
}

// ---- 原型访问器：这是被测的钩子目标 ----
Object.defineProperty(XHRMock.prototype, 'responseText', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (this.readyState < 3) {
      throw new Error('InvalidStateError: responseText not available before LOADING');
    }
    if (this.responseType && this.responseType !== 'text') {
      throw new Error('InvalidStateError: responseText only valid for text');
    }
    return this._responseText;
  },
  set: function (v) { this._responseText = v; }
});

Object.defineProperty(XHRMock.prototype, 'response', {
  configurable: true,
  enumerable: true,
  get: function () {
    if (this.readyState < 2) return '';
    if (this.responseType === 'json') {
      try { return JSON.parse(this._responseText); } catch (e) { return null; }
    }
    return this._responseText;
  },
  set: function (v) { this._responseText = v; }
});

XHRMock.prototype.open = function (method, url) {
  this._method = method;
  this._url = url;
  this.readyState = 1;
  this._emit('readystatechange');
};

XHRMock.prototype.setRequestHeader = function (k, v) {
  this._headers[String(k).toLowerCase()] = v;
};

XHRMock.prototype.getAllResponseHeaders = function () {
  return 'content-type: application/json\r\n';
};

XHRMock.prototype.getResponseHeader = function (k) {
  if (String(k).toLowerCase() === 'content-type') return 'application/json';
  return null;
};

XHRMock.prototype.send = function (body) {
  this._sentBody = body;
  this._sent = true;
};

XHRMock.prototype.abort = function () {
  this._aborted = true;
  this.readyState = 4;
  this._emit('abort');
  this._emit('loadend');
};

XHRMock.prototype.addEventListener = function (type, fn) {
  (this._listeners[type] || (this._listeners[type] = [])).push(fn);
};

XHRMock.prototype.removeEventListener = function (type, fn) {
  var a = this._listeners[type];
  if (!a) return;
  var i = a.indexOf(fn);
  if (i >= 0) a.splice(i, 1);
};

XHRMock.prototype._emit = function (type, ev) {
  var a = this._listeners[type] || [];
  for (var i = 0; i < a.length; i++) {
    try { a[i].call(this, ev || { type: type }); } catch (e) { /* 真实浏览器也会吞 */ }
  }
  var h = this['on' + type];
  if (typeof h === 'function') {
    try { h.call(this, ev || { type: type }); } catch (e) { }
  }
};

// ---- 测试驱动：按真实时序喂数据 ----
XHRMock.prototype._receiveHeaders = function (status) {
  this.status = status || 200;
  this.statusText = 'OK';
  this.readyState = 3;
  this._emit('readystatechange');
};

XHRMock.prototype._appendChunk = function (chunk) {
  this._responseText += chunk;
  if (this.readyState < 3) this.readyState = 3;
  this._emit('progress', {
    type: 'progress',
    lengthComputable: false,
    loaded: this._responseText.length,
    total: 0
  });
  this._emit('readystatechange');
};

XHRMock.prototype._finish = function () {
  this.readyState = 4;
  this._emit('readystatechange');
  this._emit('load');
  this._emit('loadend');
};

module.exports = XHRMock;
