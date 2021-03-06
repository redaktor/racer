var util = require('../util');
var Model = require('./Model');
var defaultFns = require('./defaultFns');

function NamedFns() {}

Model.INITS.push(function(model) {
  model.root._namedFns = new NamedFns();
  model.root._fns = new Fns(model);
  model.on('all', fnListener);
  function fnListener(segments, eventArgs) {
    var pass = eventArgs[eventArgs.length - 1];
    var map = model.root._fns.fromMap;
    for (var path in map) {
      var fn = map[path];
      if (pass.$fn === fn) continue;
      if (util.mayImpactAny(fn.inputsSegments, segments)) {
        // Mutation affecting input path
        fn.onInput(pass);
      } else if (util.mayImpact(fn.fromSegments, segments)) {
        // Mutation affecting output path
        fn.onOutput(pass);
      }
    }
  }
});

Model.prototype.fn = function(name, fns) {
  this.root._namedFns[name] = fns;
};

function parseStartArguments(model, args, hasPath) {
  if (typeof args[0] === 'function') {
    var fns = args[0];
  } else {
    var name = args[0];
  }
  if (hasPath) {
    var path = model.path(args[1]);
    var inputPaths = Array.prototype.slice.call(args, 2);
  } else {
    var inputPaths = Array.prototype.slice.call(args, 1);
  }
  var i = inputPaths.length - 1;
  if (model.isPath(inputPaths[i])) {
    inputPaths[i] = model.path(inputPaths[i]);
  } else {
    var options = inputPaths.pop();
  }
  while (i--) {
    inputPaths[i] = model.path(inputPaths[i]);
  }
  return {
    name: name
  , path: path
  , inputPaths: inputPaths
  , fns: fns
  , options: options
  };
}

Model.prototype.evaluate = function(name) {
  var args = parseStartArguments(this, arguments, false);
  return this.root._fns.get(args.name, args.inputPaths, args.fns, args.options);
};

Model.prototype.start = function(name, subpath) {
  var args = parseStartArguments(this, arguments, true);
  return this.root._fns.start(args.name, args.path, args.inputPaths, args.fns, args.options);
};

Model.prototype.stop = function(subpath) {
  var path = this.path(subpath);
  this.root._fns.stop(path);
};

Model.prototype.stopAll = function(subpath) {
  var segments = this._splitPath(subpath);
  var fns = this.root._fns.fromMap;
  for (var from in fns) {
    if (util.contains(segments, fns[from].fromSegments)) {
      this.stop(from);
    }
  }
};

function FromMap() {}
function Fns(model) {
  this.model = model;
  this.nameMap = model.root._namedFns;
  this.fromMap = new FromMap;
}

Fns.prototype.get = function(name, inputPaths, fns, options) {
  fns || (fns = this.nameMap[name] || defaultFns[name]);
  var fn = new Fn(this.model, name, null, inputPaths, fns, options);
  return fn.get();
};

Fns.prototype.start = function(name, path, inputPaths, fns, options) {
  fns || (fns = this.nameMap[name] || defaultFns[name]);
  var fn = new Fn(this.model, name, path, inputPaths, fns, options);
  this.fromMap[path] = fn;
  return fn.onInput();
};

Fns.prototype.stop = function(path) {
  var fn = this.fromMap[path];
  delete this.fromMap[path];
  return fn;
};

Fns.prototype.toJSON = function() {
  var out = [];
  for (var from in this.fromMap) {
    var fn = this.fromMap[from];
    // Don't try to bundle non-named functions that were started via
    // model.start directly instead of by name
    if (!fn.name) continue;
    var args = [fn.name, fn.from].concat(fn.inputPaths);
    if (fn.options) args.push(fn.options);
    out.push(args);
  }
  return out;
};

function Fn(model, name, from, inputPaths, fns, options) {
  this.model = model.pass({$fn: this});
  this.name = name;
  this.from = from;
  this.inputPaths = inputPaths;
  this.options = options;
  if (!fns) {
    var err = new TypeError('Model function not found: ' + name);
    model.emit('error', err);
  }
  this.getFn = fns.get || fns;
  this.setFn = fns.set;
  this.fromSegments = from && from.split('.');
  this.inputsSegments = [];
  for (var i = 0; i < this.inputPaths.length; i++) {
    var segments = this.inputPaths[i].split('.');
    this.inputsSegments.push(segments);
  }
  var copy = (options && options.copy) || 'output';
  this.copyInput = (copy === 'input' || copy === 'both');
  this.copyOutput = (copy === 'output' || copy === 'both');

  var equal = (options && options.equal === 'strict') ? util.equal : util.deepEqual;
  this.diffOptions = {equal: equal};

  // Mode can be 'array', 'diff', or 'set'
  this.mode = (options && options.mode) || 'diff';
}

Fn.prototype.apply = function(fn, inputs) {
  for (var i = 0, len = this.inputsSegments.length; i < len; i++) {
    var input = this.model._get(this.inputsSegments[i]);
    inputs.push(this.copyInput ? util.deepCopy(input) : input);
  }
  try {
    return fn.apply(this.model, inputs);
  } catch (err) {
    this.model.emit('error', err);
  }
};

Fn.prototype.get = function() {
  return this.apply(this.getFn, []);
};

Fn.prototype.set = function(value, pass) {
  if (!this.setFn) return;
  var out = this.apply(this.setFn, [value]);
  if (!out) return;
  var inputsSegments = this.inputsSegments;
  var model = this.model.pass(pass, true);
  for (var key in out) {
    var value = (this.copyOutput) ? util.deepCopy(out[key]) : out[key];
    this._setValue(model, inputsSegments[key], value);
  }
};

Fn.prototype.onInput = function(pass) {
  var value = (this.copyOutput) ? util.deepCopy(this.get()) : this.get();
  this._setValue(this.model.pass(pass, true), this.fromSegments, value);
  return value;
};

Fn.prototype.onOutput = function(pass) {
  var value = this.model._get(this.fromSegments);
  return this.set(value, pass);
};

Fn.prototype._setValue = function(model, segments, value) {
  if (this.mode === 'set') {
    model._set(segments, value);
  } else if (this.mode === 'array') {
    model._setArrayDiff(segments, value);
  } else {
    model._setDiff(segments, value, this.diffOptions);
  }
};
