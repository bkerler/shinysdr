// Copyright 2013, 2014 Kevin Reid <kpreid@switchb.org>
// 
// This file is part of ShinySDR.
// 
// ShinySDR is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
// 
// ShinySDR is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
// 
// You should have received a copy of the GNU General Public License
// along with ShinySDR.  If not, see <http://www.gnu.org/licenses/>.

define(['./values', './events', './widget'], function (values, events, widget) {
  'use strict';
  
  var Cell = values.Cell;
  var ConstantCell = values.ConstantCell;
  var DerivedCell = values.DerivedCell;
  var Enum = values.Enum;
  var LocalCell = values.LocalCell;
  var Notice = values.Notice;
  var alwaysCreateReceiverFromEvent = widget.alwaysCreateReceiverFromEvent;
  var createWidgetExt = widget.createWidgetExt;
  var addLifecycleListener = widget.addLifecycleListener;
  
  // contains *only* widget types and can be used as a lookup namespace
  var widgets = Object.create(null);
  
  function mod(value, modulus) {
    return (value % modulus + modulus) % modulus;
  }
  
  // TODO get this from server
  var allModes = Object.create(null);
  allModes.WFM = 'Wide FM';
  allModes.NFM = 'Narrow FM';
  allModes.AM = 'AM';
  allModes.LSB = 'Lower SSB';
  allModes.USB = 'Upper SSB';
  allModes.VOR = 'VOR';
  
  // Superclass for a sub-block widget
  function Block(config, optSpecial, optEmbed) {
    var block = config.target.depend(config.rebuildMe);
    block._reshapeNotice.listen(config.rebuildMe);
    var container = this.element = config.element;
    var appendTarget = container;
    var claimed = Object.create(null);
    
    //container.textContent = '';
    container.classList.add('frame');
    if (config.shouldBePanel && !optEmbed) {
      container.classList.add('panel');
    }
    
    function getAppend() {
      if (appendTarget === 'details') {
        appendTarget = container.appendChild(document.createElement('details'));
        if (config.idPrefix) {
          // hook for state persistence
          appendTarget.id = config.idPrefix + '_details';
        }
        appendTarget.appendChild(document.createElement('summary')).textContent = 'More';
      }
      
      return appendTarget;
    }
    
    function addWidget(name, widgetType, optBoxLabel) {
      var wEl = document.createElement('div');
      if (optBoxLabel !== undefined) { wEl.classList.add('panel'); }
      
      var targetCell;
      if (typeof name === 'string') {
        claimed[name] = true;
        targetCell = block[name];
        if (config.idPrefix) {
          wEl.id = config.idPrefix + name;
        }
      } else {
        targetCell = new ConstantCell(values.block, block);
      }
      
      if (optBoxLabel !== undefined) {
        wEl.setAttribute('title', optBoxLabel);
      }
      
      var widgetCtor;
      if (typeof widgetType === 'string') {
        throw new Error('string widget types being deprecated, not supported here');
      } else {
        widgetCtor = widgetType;
      }
      
      getAppend().appendChild(wEl);
      // TODO: Maybe createWidgetExt should be a method of the context?
      createWidgetExt(config.context, widgetCtor, wEl, targetCell);
    }
    
    function ignore(name) {
      claimed[name] = true;
    }
    
    // TODO be less imperative
    function setInsertion(el) {
      appendTarget = el;
    }
    
    function setToDetails() {
      // special value which is instantiated if anything actually gets appended
      appendTarget = 'details';
    }
    
    if (optSpecial) {
      optSpecial.call(this, block, addWidget, ignore, setInsertion, setToDetails, getAppend);
    }
    
    var names = [];
    for (var name in block) names.push(name);
    names.sort();
    names.forEach(function (name) {
      if (claimed[name]) return;
      
      var member = block[name];
      if (member instanceof Cell) {
        // TODO: Stop using Boolean etc. as type objects and remove the need for this feature test
        if (member.type.isSingleValued && member.type.isSingleValued()) {
          return;
        }
        // TODO: Add a dispatch table of some sort to de-centralize this
        if (member.type instanceof values.Range) {
          if (member.set) {
            addWidget(name, member.type.logarithmic ? LogSlider : LinSlider, name);
          } else {
            addWidget(name, Meter, name);
          }
        } else if (member.type instanceof values.Enum) {
          addWidget(name, Radio, name);
        } else if (member.type === Boolean) {
          addWidget(name, Toggle, name);
        } else if (member.type instanceof Notice) {
          addWidget(name, Banner, name);
        } else if (member.type === values.block) {  // TODO colliding name
          // TODO: Add hook to choose a widget class based on interfaces
          // Furthermore, use that for the specific block widget classes too, rather than each one knowing the types of its sub-widgets.
          addWidget(name, PickBlock);
        } else {
          addWidget(name, Generic, name);
        }
      } else {
        console.warn('Block scan got unexpected object:', member);
      }
    });
  }
  widgets.Block = Block;
  
  // Delegate to a block widget based on the block's interfaces, or default to Block.
  function PickBlock(config) {
    if (Object.getPrototypeOf(this) !== PickBlock.prototype) {
      throw new Error('cannot inherit from PickBlock');
    }
    
    var targetCell = config.target;
    var context = config.context;
    
    var ctorCell = new DerivedCell(values.block, config.scheduler, function (dirty) {
      var block = targetCell.depend(dirty);
      
      // TODO kludgy, need better representation of interfaces
      var ctor;
      Object.getOwnPropertyNames(block).some(function (key) {
        var match = /^_implements_(.*)$/.exec(key);
        if (match) {
          var interface_ = match[1];
          // TODO better scheme for registering widgets for interfaces
          ctor = context.widgets['interface:' + interface_];
          if (ctor) return true;
        }
      });
      
      return ctor || Block;
    });
    
    return new (ctorCell.depend(config.rebuildMe))(config);
  }
  widgets.PickBlock = PickBlock;
  
  // Suppresses all visibility of null objects
  function NullWidget(config) {
    Block.call(this, config, function () {}, true);
  }
  widgets['interface:shinysdr.values.INull'] = NullWidget;
  
  // Widget for the top block
  function Top(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      // TODO: It's a lousy design to require widgets to know what not to show. We should have a generic system for multiple widgets to decide "OK, you'll display this and I won't".
      ignore('preset');  // displayed separately, not real state
      ignore('targetDB');  // not real state
      ignore('monitor');  // displayed separately
      ignore('shared_objects');  // displayed separately
      
      if ('unpaused' in block) {
        addWidget('unpaused', Toggle, 'Run');
      }
      
      var sourceToolbar = this.element.appendChild(document.createElement('div'));
      sourceToolbar.className = 'panel frame-controls';
      sourceToolbar.appendChild(document.createTextNode('RF source '));
      if ('source_name' in block) {
        ignore('source_name');
        var sourceEl = sourceToolbar.appendChild(document.createElement('select'));
        createWidgetExt(config.context, Select, sourceEl, block.source_name);
      }
      
      if (false) { // TODO: Figure out a good way to display options for all sources
        ignore('source');
        if ('sources' in block) {
          addWidget('sources', DeviceSet);
        }
      } else {
        ignore('sources');
        if ('source' in block) {
          addWidget('source', Device);
        }
      }
      addWidget('clip_warning', Banner);
      if ('receivers' in block) {
        addWidget('receivers', ReceiverSet);
      }
      addWidget('accessories', AccessorySet);
      
      setToDetails();
    });
  }
  widgets.Top = Top;
  
  function BlockSet(widgetCtor, buildEntry) {
    return function TypeSetInst(config) {
      // We do not inherit from Block, because we don't want the rebuild-on-reshape behavior (so we can do something more efficient) and we don't need the rest of it.
      var block = config.target.depend(config.rebuildMe);
      var idPrefix = config.idPrefix;
      var childContainer = this.element = config.element;

      // Keys are block keys
      var childWidgetElements = Object.create(null);

      var createChild = function (name) {
        var toolbar;
        var widgetContainer = childContainer;
        function setInsertion(element) {
          widgetContainer = element;
        }
        // buildContainer must append exactly one child. TODO: cleaner
        var widgetPlaceholder = buildEntry(childContainer, block, name);
        if (idPrefix) {
          widgetPlaceholder.id = idPrefix + name;
        }
        var widgetContainer = childContainer.lastChild;
        var widgetHandle = createWidgetExt(config.context, widgetCtor, widgetPlaceholder, block[name]);
        return {
          toolbar: toolbar,
          widgetHandle: widgetHandle,
          element: widgetContainer
        };
      }.bind(this);

      function handleReshape() {
        block._reshapeNotice.listen(handleReshape);
        Object.keys(block).forEach(function (name) {
          if (!childWidgetElements[name]) {
            childWidgetElements[name] = createChild(name);
          }
        });
        for (var oldName in childWidgetElements) {
          if (!(oldName in block)) {
            childWidgetElements[oldName].widgetHandle.destroy();
            childContainer.removeChild(childWidgetElements[oldName].element);
            delete childWidgetElements[oldName];
          }
        }
      }
      handleReshape.scheduler = config.scheduler;
      handleReshape();
    };
  }
  widgets.BlockSet = BlockSet;
  
  function BlockSetInFrameEntryBuilder(userTypeName) {
    return function blockSetInFrameEntryBuilder(setElement, block, name) {
      var container = setElement.appendChild(document.createElement('div'));
      container.className = 'frame';
      var toolbar = container.appendChild(document.createElement('div'));
      toolbar.className = 'panel frame-controls';
      
      if (block['_implements_shinysdr.values.IWritableCollection']) {
        var del = document.createElement('button');
        del.textContent = '\u2573';
        del.className = 'frame-delete-button';
        toolbar.appendChild(del);
        del.addEventListener('click', function(event) {
          block.delete(name);
        });
      }
      
      toolbar.appendChild(document.createTextNode(' ' + userTypeName + ' '));
      
      var label = document.createElement('span');
      label.textContent = name;
      toolbar.appendChild(label);
      
      return container.appendChild(document.createElement('div'));
    };
  }
  
  function windowEntryBuilder(setElement, block, name, setInsertion) {
    var subwindow = document.createElement('shinysdr-subwindow');
    var header = subwindow.appendChild(document.createElement('h2'));
    header.appendChild(document.createTextNode(name));  // TODO formatting
    var body = subwindow.appendChild(document.createElement('div'));
    body.classList.add('sidebar');  // TODO not quite right class -- we want main-ness but scrolling
    body.classList.add('frame');
    
    setElement.appendChild(subwindow);
    return body.appendChild(document.createElement('div'));
  }
  
  function blockSetNoHeader(setElement, block, name, setInsertion) {
    return setElement.appendChild(document.createElement('div'));
  }
  
  var DeviceSet = widgets.DeviceSet = BlockSet(Device, BlockSetInFrameEntryBuilder('Device'));
  var ReceiverSet = widgets.ReceiverSet = BlockSet(Receiver, BlockSetInFrameEntryBuilder('Receiver'));
  var AccessorySet = widgets.AccessorySet = BlockSet(PickBlock, BlockSetInFrameEntryBuilder('Accessory'));
  widgets.WindowBlocks = BlockSet(PickBlock, windowEntryBuilder);
  
  // Widget for a device
  function Device(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      var freqCell = block.freq;
      if (!freqCell.type.isSingleValued()) {
        addWidget('freq', Knob, 'Center frequency');
      }
      addWidget('rx_driver', PickBlock);
      addWidget('tx_driver', PickBlock);
      addWidget('components', ComponentSet);
    });
  }
  widgets['interface:shinysdr.devices.IDevice'] = Device;
  var ComponentSet = BlockSet(PickBlock, blockSetNoHeader);
  
  // Widget for a RX driver block -- TODO break this stuff up
  function RXDriver(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      // If we have multiple gain-related controls, do a combined UI
      // TODO: Better feature-testing strategy
      var hasAGC = 'agc' in block;
      var hasSingleGain = 'gain' in block;
      var hasMultipleGain = 'gains' in block;
      if (hasAGC + hasSingleGain + hasMultipleGain > 1) (function () {
        var gainModes = {};
        if (hasAGC) { gainModes['auto'] = 'AGC On'; ignore('agc'); }
        if (hasSingleGain) { gainModes['single'] = 'Manual Gain'; }
        if (hasMultipleGain) { gainModes['stages'] = 'Stages'; }
        Object.freeze(gainModes);
        var gainModeType = new Enum(gainModes);
        var gainModeCell = new LocalCell(gainModeType, block.agc.get() ? 'auto' : 'single');

        var gainPanel = getAppend().appendChild(document.createElement('div'));
        //gainPanel.appendChild(document.createTextNode('Gain '));
        var gainModeControl = gainPanel.appendChild(document.createElement('span'));
        createWidgetExt(config.context, Radio, gainModeControl, gainModeCell);
        
        var singleGainPanel;
        if (hasSingleGain) {
          singleGainPanel = gainPanel.appendChild(document.createElement('div'));
          createWidgetExt(config.context, LinSlider, singleGainPanel.appendChild(document.createElement('div')), block.gain);
          ignore('gain');
        }
        var multipleGainPanel;
        if (hasMultipleGain) {
          multipleGainPanel = gainPanel.appendChild(document.createElement('div'));
          createWidgetExt(config.context, Block, multipleGainPanel.appendChild(document.createElement('div')), block.gains);
          ignore('gains');
        }
        
        // TODO: Figure out how to break these notify loops
        function bindGainModeSet() {
          var mode = gainModeCell.depend(bindGainModeSet);
          if (mode === 'auto' && !block.agc.get()) {
            block.agc.set(true);
          } else if (hasAGC) {
            block.agc.set(false);
          }
        }
        bindGainModeSet.scheduler = config.scheduler;
        bindGainModeSet();
        function bindGainModeGet() {
          if (hasAGC && block.agc.depend(bindGainModeGet)) {
            gainModeCell.set('auto');
          } else if (gainModeCell.get() === 'auto') {
            gainModeCell.set('single');
          }
        }
        bindGainModeGet.scheduler = config.scheduler;
        bindGainModeGet();

        function updateUI() {
          var mode = gainModeCell.depend(updateUI);
          if (hasSingleGain) {
            singleGainPanel.style.display = mode === 'single' ? 'block' : 'none';
          }
          if (hasMultipleGain) {
            multipleGainPanel.style.display = mode === 'stages' ? 'block' : 'none';
          }
        }
        updateUI.scheduler = config.scheduler;
        updateUI();
      }());
      
      setToDetails();
      
      if ('correction_ppm' in block) {
        addWidget('correction_ppm', SmallKnob, 'Freq.corr. (PPM)');
      }
      
      ignore('output_type');
    }, true);
  }
  widgets.RXDriver = RXDriver;
  widgets['interface:shinysdr.devices.IRXDriver'] = RXDriver;
  
  // Widget for a receiver block
  function Receiver(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      ignore('is_valid');
      if ('rec_freq' in block) {
        addWidget('rec_freq', Knob, 'Channel frequency');
      }
      if ('mode' in block) {
        addWidget('mode', Radio);
      }
      addWidget('demodulator', Demodulator);
      if ('audio_power' in block) {
        addWidget('audio_power', Meter, 'Audio');
      }
      if ('audio_gain' in block) {
        addWidget('audio_gain', LinSlider, 'Volume');
      }
      if ('audio_pan' in block && !block.audio_pan.type.isSingleValued()) {
        addWidget('audio_pan', LinSlider, 'Pan');
      }
      if ('rec_freq' in block) {
        addWidget(null, SaveButton);
      }
    });
  }
  widgets.Receiver = Receiver;
  
  // Widget for a demodulator block
  function Demodulator(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      ignore('band_filter_shape');
      if ('rf_power' in block && 'squelch_threshold' in block) (function() {
        var squelchAndPowerPanel = this.element.appendChild(document.createElement('table'));
        squelchAndPowerPanel.classList.add('panel');
        squelchAndPowerPanel.classList.add('widget-Demodulator-squelch-and-power');
        function addRow(label, wtarget, wclass, wel) {
          ignore(wtarget);
          var row = squelchAndPowerPanel.appendChild(document.createElement('tr'));
          row.appendChild(document.createElement('th'))
            .appendChild(document.createTextNode(label));
          var widgetEl = row.appendChild(document.createElement('td'))
            .appendChild(document.createElement(wel));
          if (wel === 'input') widgetEl.type = 'range';
          createWidgetExt(config.context, wclass, widgetEl, block[wtarget]);
          var numberEl = row.appendChild(document.createElement('td'))
            .appendChild(document.createElement('tt'));
          createWidgetExt(config.context, NumberWidget, numberEl, block[wtarget]);
        }
        addRow('RF', 'rf_power', Meter, 'meter');
        addRow('Squelch', 'squelch_threshold', LinSlider, 'input');
      }.call(this)); else {
        if ('rf_power' in block) {
          addWidget('rf_power', Meter, 'Power');
        }
        if ('squelch_threshold' in block) {
          addWidget('squelch_threshold', LinSlider, 'Squelch');
        }
      }
      
      // TODO break dependency on plugin
      if ('angle' in block) {
        addWidget('angle', widgets.VOR$Angle, '');
      }
      ignore('zero_point');
    }, true);
  }
  widgets.Demodulator = Demodulator;
  
  // Widget for a monitor block
  function Monitor(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      var element = this.element = config.element;
      element.classList.add('hscalegroup');
      element.id = config.element.id;
      
      // TODO: shouldn't need to have this declared, should be implied by context
      var isRFSpectrum = config.element.hasAttribute('data-is-rf-spectrum');
      var context = config.context.withSpectrumView(element, block, isRFSpectrum);
      
      var overlayContainer = element.appendChild(document.createElement('div'));
      overlayContainer.classList.add('hscale');
      function makeOverlayPiece(name) {
        var el = overlayContainer.appendChild(document.createElement(name));
        el.classList.add('overlay');
        return el;
      }
      if (isRFSpectrum) createWidgetExt(context, ReceiverMarks, makeOverlayPiece('div'), block.fft);
      createWidgetExt(context, SpectrumPlot, makeOverlayPiece('canvas'), block.fft);
      ignore('fft');
      
      // TODO this is clunky. (Note we're not just using rebuildMe because we don't want to lose waterfall history and reinit GL and and and...)
      var radioCell = config.radioCell;
      var freqCell = new DerivedCell(Number, config.scheduler, function (dirty) {
        return radioCell.depend(dirty).source.depend(dirty).freq.depend(dirty);
      });
      createWidgetExt(context, FreqScale, element.appendChild(document.createElement('div')), freqCell);
      
      createWidgetExt(context, WaterfallPlot, element.appendChild(document.createElement('canvas')), block.fft);
      
      ignore('scope');
      ignore('time_length');
      
      // TODO should logically be doing this -- need to support "widget with possibly multiple target elements"
      //addWidget(null, MonitorParameters);
      ignore('signal_type');
      ignore('frame_rate');
      ignore('freq_resolution');
      
      // kludge to trigger SpectrumView layout computations after it's added to the DOM :(
      setTimeout(function() {
        var resize = document.createEvent('Event');
        resize.initEvent('resize', false, false);
        window.dispatchEvent(resize);
      }, 0);
    });
  }
  widgets.Monitor = Monitor;
  
  // Widget for incidental controls for a monitor block
  function MonitorParameters(config) {
    Block.call(this, config, function (block, addWidget, ignore, setInsertion, setToDetails, getAppend) {
      ignore('signal_type');
      ignore('fft');
      ignore('scope');
      if ('frame_rate' in block) {
        addWidget('frame_rate', LogSlider, 'Rate');
      }
      if ('freq_resolution' in block) {
        addWidget('freq_resolution', LogSlider, 'Resolution');
      }
      ignore('time_length');
    });
  }
  widgets.MonitorParameters = MonitorParameters;

  var GLtools = {
    getGL: function getGL(config, canvas, options) {
      var useWebGL = config.clientState.opengl.depend(config.rebuildMe);
      return !useWebGL ? null : canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
    },
    buildProgram: function buildProgram(gl, vertexShaderSource, fragmentShaderSource) {
      function compileShader(type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
          throw new Error(gl.getShaderInfoLog(shader));
        }
        return shader;
      }
      var vertexShader = compileShader(gl.VERTEX_SHADER, vertexShaderSource);
      var fragmentShader = compileShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
      var program = gl.createProgram();
      gl.attachShader(program, vertexShader);
      gl.attachShader(program, fragmentShader);
      gl.linkProgram(program);
      if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
        throw new Error(gl.getProgramInfoLog(program));
      }
      gl.useProgram(program);
      return program;
    }
  }
  
  // Abstract
  function CanvasSpectrumWidget(config, buildGL, build2D) {
    var self = this;
    var fftCell = config.target;
    var view = config.view;
    
    var canvas = config.element;
    if (canvas.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
    }
    this.element = canvas;
    view.addClickToTune(canvas);
    
    var glOptions = {
      alpha: true,
      depth: false,
      stencil: false,
      antialias: false,
      preserveDrawingBuffer: false
    };
    var gl = GLtools.getGL(config, canvas, glOptions);
    var ctx2d = canvas.getContext('2d');
    
    var dataHook = function () {}, drawOuter = function () {};
    
    var draw = config.boundedFn(function drawOuterTrampoline() {
      drawOuter();
    });
    draw.scheduler = config.scheduler;
    
    if (gl) (function() {
      function initContext() {
        var att_position;
        function buildProgram(vertexShaderSource, fragmentShaderSource) {
          var program = GLtools.buildProgram(gl, vertexShaderSource, fragmentShaderSource);
          att_position = gl.getAttribLocation(program, 'position');
          gl.enableVertexAttribArray(att_position);
          return program;
        }
        
        var quadBuffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
        var f;
        gl.bufferData(gl.ARRAY_BUFFER, f = new Float32Array([
          // full screen triangle strip
          -1, -1, 0, 1,
          1, -1, 0, 1,
          -1, 1, 0, 1,
          1, 1, 0, 1
        ]), gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
        
        var drawImpl = buildGL(gl, buildProgram, draw);
        dataHook = drawImpl.newData.bind(drawImpl);
        
        drawOuter = function () {
          gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
          gl.vertexAttribPointer(
            att_position,
            4, // components
            gl.FLOAT,
            false,
            0,
            0);
          gl.bindBuffer(gl.ARRAY_BUFFER, null);
          drawImpl.beforeDraw();
          gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);  // 4 vertices
        };
      }
      
      initContext();
      canvas.addEventListener('webglcontextlost', function (event) {
        event.preventDefault();
      }, false);
      canvas.addEventListener('webglcontextrestored', initContext, false);
    }.call(this)); else if (ctx2d) (function () {
      var drawImpl = build2D(ctx2d, draw);
      dataHook = drawImpl.newData.bind(drawImpl);
      drawOuter = drawImpl.performDraw.bind(drawImpl);
    }.call(this));
    
    function newFFTFrame(bundle) {
      dataHook(bundle);
      draw.scheduler.enqueue(draw);
    }
    newFFTFrame.scheduler = config.scheduler;

    fftCell.subscribe(newFFTFrame);
    draw();
  }
  
  function ScopePlot(config) {
    var self = this;
    var scopeCell = config.target;
    var storage = config.storage;
    var scheduler = config.scheduler;
    
    var canvas = config.element;
    if (canvas.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
    }
    this.element = canvas;
    
    var viewAngle = storage ? (+storage.getItem('angle')) || 0 : 0;
    
    var bufferToDraw = null;
    var lastLength = NaN;
    
    var gl = GLtools.getGL(config, canvas, {
      alpha: false,
      depth: true,
      stencil: false,
      antialias: true,
      preserveDrawingBuffer: false
    });
    gl.enable(gl.DEPTH_TEST);
    
    var att_time;
    var att_signal;
    
    var timeBuffer = gl.createBuffer();
    var signalBuffer = gl.createBuffer();
    
    var vertexShaderSource = ''
      + 'attribute float time;\n'
      + 'attribute vec2 signal;\n'
      + 'uniform mat4 projection;\n'
      + 'uniform bool channel;\n'
      + 'varying mediump float v_time;\n'
      + 'varying mediump vec2 v_signal;\n'
      + 'void main(void) {\n'
      + '  float y = channel ? signal.x : signal.y;\n'
      + '  //gl_Position = vec4(time * 2.0 - 1.0, y, 0.0, 1.0);\n'
      + '  vec4 basePos = vec4(signal, time * 2.0 - 1.0, 1.0);\n'
      + '  gl_Position = basePos * projection;\n'
      + '  v_time = time;\n'
      + '  v_signal = signal;\n'
      + '}\n';
    var fragmentShaderSource = ''
      + 'varying mediump float v_time;\n'
      + 'void main(void) {\n'
      + '  gl_FragColor = vec4(v_time, 1.0 - v_time, 0.0, 1.0);\n'
      + '}\n';
    var program = GLtools.buildProgram(gl, vertexShaderSource, fragmentShaderSource);
    var att_time = gl.getAttribLocation(program, 'time');
    var att_signal = gl.getAttribLocation(program, 'signal');
    gl.enableVertexAttribArray(att_time);
    gl.enableVertexAttribArray(att_signal);
    gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
    gl.vertexAttribPointer(
      att_time,
      1, // components
      gl.FLOAT,
      false,
      0,
      0);
    gl.bindBuffer(gl.ARRAY_BUFFER, signalBuffer);
    gl.vertexAttribPointer(
      att_signal,
      2, // components
      gl.FLOAT,
      false,
      0,
      0);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    
    canvas.addEventListener('webglcontextlost', function (event) {
      event.preventDefault();
    }, false);
    canvas.addEventListener('webglcontextrestored', config.rebuildMe, false);
    
    // dragging
    function drag(event) {
      viewAngle += (event.movementX || event.webkitMovementX) * 0.01;
      viewAngle = Math.min(Math.PI / 2, Math.max(0, viewAngle));
      if (storage) storage.setItem('angle', viewAngle);
      scheduler.enqueue(draw);
      event.stopPropagation();
      event.preventDefault(); // no drag selection
    }
    canvas.addEventListener('mousedown', function(event) {
      if (event.button !== 0) return;  // don't react to right-clicks etc.
      event.preventDefault();
      document.addEventListener('mousemove', drag, true);
      document.addEventListener('mouseup', function(event) {
        document.removeEventListener('mousemove', drag, true);
      }, true);
    }, false);
    
    var draw = config.boundedFn(function drawImpl() {
      if (!bufferToDraw) return;
      
      var w, h;
      // Fit current layout
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) {
        // implicitly clears
        canvas.width = w;
        canvas.height = h;
      }
      var aspect = w / h;
      gl.viewport(0, 0, w, h);
      
      if (lastLength != bufferToDraw.length / 2) {
        lastLength = bufferToDraw.length / 2;
        gl.bindBuffer(gl.ARRAY_BUFFER, timeBuffer);
        var timeIndexes = new Float32Array(lastLength);
        for (var i = 0; i < lastLength; i++) {
          timeIndexes[i] = i / lastLength;
        }
        if (bufferToDraw) gl.bufferData(gl.ARRAY_BUFFER, timeIndexes, gl.STREAM_DRAW);
      }
      
      if (bufferToDraw) {
        gl.bindBuffer(gl.ARRAY_BUFFER, signalBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, bufferToDraw, gl.STREAM_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, null);
      }

      gl.uniformMatrix4fv(gl.getUniformLocation(program, 'projection'), false, new Float32Array([
        Math.cos(viewAngle) / aspect, 0, -Math.sin(viewAngle), 0,
        0, 1, 0, 0,
        Math.sin(viewAngle) / aspect, 0, Math.cos(viewAngle), 0,
        0, 0, 0, 1,
      ]));
      
      gl.uniform1f(gl.getUniformLocation(program, 'channel'), 0);
      gl.drawArrays(gl.LINE_STRIP, 0, lastLength);
      gl.uniform1f(gl.getUniformLocation(program, 'channel'), 1);
      gl.drawArrays(gl.LINE_STRIP, 0, lastLength);
    });
    draw.scheduler = config.scheduler;
    
    function newScopeFrame(bundle) {
      bufferToDraw = bundle[1];
      draw.scheduler.enqueue(draw);
    }
    newScopeFrame.scheduler = config.scheduler;

    scopeCell.subscribe(newScopeFrame);
    draw();
  }
  widgets.ScopePlot = ScopePlot;
  
  function SpectrumPlot(config) {
    var self = this;
    var fftCell = config.target;
    var view = config.view;
    var avgAlphaCell = config.clientState.spectrum_average;
    
    var canvas; // set later
    
    // common logic
    var averageBuffer = null;
    var lastDrawnCenterFreq = NaN;
    function commonNewData(fftBundle) {
      var buffer = fftBundle[1];
      var bufferCenterFreq = fftBundle[0].freq;
      var len = buffer.length;
      var alpha = avgAlphaCell.get();
      var invAlpha = 1 - alpha;

      // averaging
      // TODO: Get separate averaged and unaveraged FFTs from server so that averaging behavior is not dependent on frame rate over the network
      if (!averageBuffer
          || averageBuffer.length !== len
          || (lastDrawnCenterFreq !== bufferCenterFreq
              && !isNaN(bufferCenterFreq))) {
        lastDrawnCenterFreq = bufferCenterFreq;
        averageBuffer = new Float32Array(buffer);
      }

      for (var i = 0; i < len; i++) {
        averageBuffer[i] = averageBuffer[i] * invAlpha + buffer[i] * alpha;
      }
    }

    var lvf, rvf, w, h;
    function commonBeforeDraw(scheduledDraw) {
      view.n.listen(scheduledDraw);
      lvf = view.leftVisibleFreq();
      rvf = view.rightVisibleFreq();

      // Fit current layout
      canvas.style.marginLeft = view.freqToCSSLeft(lvf);
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) {
        // implicitly clears
        canvas.width = w;
        canvas.height = h;
        return true;
      }
    }
    
    CanvasSpectrumWidget.call(this, config, buildGL, build2D);
    
    function buildGL(gl, buildProgram, draw) {
      canvas = self.element;
      var vertexShaderSource = ''
        + 'attribute vec4 position;\n'
        + 'uniform mediump float xZero, xScale;\n'
        + 'varying highp vec2 v_position;\n'
        + 'void main(void) {\n'
        + '  gl_Position = position;\n'
        + '  mediump vec2 basePos = (position.xy + vec2(1.0)) / 2.0;\n'
        + '  v_position = vec2(xScale * basePos.x + xZero, basePos.y);\n'
        + '}\n';
      var fragmentShaderSource = ''
        + 'uniform sampler2D data;\n'
        + 'uniform mediump float xScale, xRes, yRes;\n'
        + 'varying highp vec2 v_position;\n'
        // TODO: these colors should come from the theme css
        + 'const lowp vec4 background = vec4(0.0, 0.0, 0.0, 0.0);\n'
        + 'const lowp vec4 stroke = vec4(0.0, 1.0, 0.68, 1.0);\n'
        //+ 'const lowp vec4 weakStroke = vec4(0.0, 0.5, 0.50, 1.0);\n'
        + 'const lowp vec4 fill = vec4(0.25, 0.39, 0.39, 1.0) * 0.75;\n'
        + 'const int stepRange = 8;\n'
        + 'mediump vec4 cmix(mediump vec4 before, mediump vec4 after, mediump float a) {\n'
        + '  return mix(before, after, clamp(a, 0.0, 1.0));\n'
        + '}\n'
        + 'mediump vec4 cut(mediump float boundary, mediump float offset, mediump vec4 before, mediump vec4 after) {\n'
        + '  mediump float case = (boundary - v_position.y) * yRes + offset;\n'
        + '  return cmix(before, after, case);\n'
        + '}\n'
        + 'void main(void) {\n'
        + '  highp vec2 texLookup = mod(v_position, 1.0);\n'
        + '  highp float dTex = xScale / xRes * (1.3 / float(stepRange));\n'
        + '  mediump float accum = 0.0;\n'
        + '  mediump float peak = -1.0;\n'
        + '  mediump float valley = 2.0;\n'
        + '  for (int i = -stepRange; i <= stepRange; i++) {\n'
        + '    mediump float value = texture2D(data, texLookup + dTex * float(i)).r;\n'
        + '    accum += value;\n'
        + '    peak = max(peak, value);\n'
        + '    valley = min(valley, value);\n'
        + '  }\n'
        + '  accum *= 1.0/(float(stepRange) * 2.0 + 1.0);\n'
        + '  mediump vec4 color = cut(peak, 1.0, background, cut(accum, 0.0, stroke, fill));\n'
        + '  gl_FragColor = color;\n'
        + '}\n';
      var program = buildProgram(vertexShaderSource, fragmentShaderSource);

      var fftSize = Math.max(1, config.target.get().length);

      function setScale() {
        var w = canvas.width;
        var h = canvas.height;
        gl.uniform1f(gl.getUniformLocation(program, 'xRes'), w);
        gl.uniform1f(gl.getUniformLocation(program, 'yRes'), h);
        gl.viewport(0, 0, w, h);
      }
      setScale();

      var bufferTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);  // doesn't matter
      gl.bindTexture(gl.TEXTURE_2D, null);

      function configureTexture() {
        var init = new Uint8Array(fftSize*4);
        gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0, // level
          gl.LUMINANCE, // internalformat
          fftSize, // width (= fft size)
          1, // height (actually a 1D texture)
          0, // border
          gl.LUMINANCE, // format
          gl.UNSIGNED_BYTE, // type
          init);
        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      configureTexture();

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'data'), 1);
      gl.activeTexture(gl.TEXTURE0);

      var intConversionBuffer, intConversionOut;
      
      return {
        newData: function (fftBundle) {
          var buffer = fftBundle[1];
          var bufferCenterFreq = fftBundle[0].freq;
          if (buffer.length === 0) {
            return;
          }
          if (buffer.length !== fftSize || !intConversionBuffer) {
            fftSize = buffer.length;
            configureTexture();
            intConversionBuffer = new Uint8ClampedArray(fftSize);
            intConversionOut = new Uint8Array(intConversionBuffer.buffer);
          }

          commonNewData(fftBundle);

          gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
          var minLevel = view.minLevel;
          var maxLevel = view.maxLevel;
          var cscale = 255 / (maxLevel - minLevel);
          for (var i = 0; i < fftSize; i++) {
            intConversionBuffer[i] = (averageBuffer[i] - minLevel) * cscale;
          }
          gl.texSubImage2D(
              gl.TEXTURE_2D,
              0, // level
              0, // xoffset
              0, // yoffset
              fftSize,
              1,
              gl.LUMINANCE,
              gl.UNSIGNED_BYTE,
              intConversionOut);
          gl.bindTexture(gl.TEXTURE_2D, null);
        },
        beforeDraw: function () {
          var didResize = commonBeforeDraw(draw);
          if (didResize) {
            setScale();
          }

          // Adjust drawing region
          var viewCenterFreq = view.getCenterFreq();
          var lsf = view.leftFreq();
          var rsf = view.rightFreq();
          var bandwidth = rsf - lsf;
          var halfBinWidth = bandwidth / fftSize / 2;
          var xScale = (rvf-lvf)/(rsf-lsf);
          // The half bin width correction is because OpenGL texture coordinates put (0,0) between texels, not centered on one.
          var xZero = (lvf - viewCenterFreq + halfBinWidth)/(rsf-lsf);
          gl.uniform1f(gl.getUniformLocation(program, 'xZero'), xZero);
          gl.uniform1f(gl.getUniformLocation(program, 'xScale'), xScale);

        }
      };
    }

    function build2D(ctx, draw) {
      canvas = self.element;      
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      var fillStyle = 'white';
      var strokeStyle = 'white';
      addLifecycleListener(canvas, 'init', function() {
        fillStyle = getComputedStyle(canvas).fill;
        strokeStyle = getComputedStyle(canvas).stroke;
      });
      
      // Drawing parameters and functions
      // Each variable is updated in draw()
      // This is done so that the functions need not be re-created
      // each frame.
      var xZero, xScale, xNegBandwidthCoord, xPosBandwidthCoord, yZero, yScale, firstPoint, lastPoint, fftLen;
      function freqToCoord(freq) {
        return (freq - lvf) / (rvf-lvf) * w;
      }
      function path() {
        ctx.beginPath();
        ctx.moveTo(xNegBandwidthCoord - xScale, h + 2);
        for (var i = firstPoint; i <= lastPoint; i++) {
          ctx.lineTo(xZero + i * xScale, yZero + averageBuffer[mod(i, fftLen)] * yScale);
        }
        ctx.lineTo(xPosBandwidthCoord + xScale, h + 2);
      }
      
      return {
        newData: function (fftBundle) {
          commonNewData(fftBundle);
        },
        performDraw: function () {
          var didClear = commonBeforeDraw(draw);
          if (!didClear) {
            ctx.clearRect(0, 0, w, h);
          }

          fftLen = averageBuffer.length;
          var halfFFTLen = Math.floor(fftLen / 2);
          
          if (halfFFTLen <= 0) {
            // no data yet, don't try to draw
            return;
          }

          var viewCenterFreq = view.getCenterFreq();
          xZero = freqToCoord(viewCenterFreq);
          xNegBandwidthCoord = freqToCoord(view.leftFreq());
          xPosBandwidthCoord = freqToCoord(view.rightFreq());
          xScale = (xPosBandwidthCoord - xNegBandwidthCoord) / fftLen;
          yScale = -h / (view.maxLevel - view.minLevel);
          yZero = -view.maxLevel * yScale;

          // choose points to draw
          firstPoint = Math.floor(-xZero / xScale) - 1;
          lastPoint = Math.ceil((w - xZero) / xScale) + 1;

          // Fill is deliberately over stroke. This acts to deemphasize downward stroking of spikes, which tend to occur in noise.
          ctx.fillStyle = fillStyle;
          ctx.strokeStyle = strokeStyle;
          path();
          ctx.stroke();
          path();
          ctx.fill();
        }
      };
    }
  }
  widgets.SpectrumPlot = SpectrumPlot;
  
  function WaterfallPlot(config) {
    var self = this;
    var fftCell = config.target;
    var view = config.view;
    
    // I have read recommendations that color gradient scales should not involve more than two colors, as certain transitions between colors read as overly significant. However, in this case (1) we are not intending the waterfall chart to be read quantitatively, and (2) we want to have distinguishable small variations across a large dynamic range.
    var colors = [
      [0, 0, 0],
      [0, 0, 255],
      [0, 200, 255],
      [255, 255, 0],
      [255, 0, 0]
    ];
    var colorCountForScale = colors.length - 1;
    var colorCountForIndex = colors.length - 2;
    // value from 0 to 1, writes 0..255 into 4 elements of outArray
    function interpolateColor(value, outArray, base) {
      value *= colorCountForScale;
      var colorIndex = Math.max(0, Math.min(colorCountForIndex, Math.floor(value)));
      var colorInterp1 = value - colorIndex;
      var colorInterp0 = 1 - colorInterp1;
      var color0 = colors[colorIndex];
      var color1 = colors[colorIndex + 1];
      outArray[base    ] = color0[0] * colorInterp0 + color1[0] * colorInterp1;
      outArray[base + 1] = color0[1] * colorInterp0 + color1[1] * colorInterp1;
      outArray[base + 2] = color0[2] * colorInterp0 + color1[2] * colorInterp1;
      outArray[base + 3] = 255;
    }
    
    var backgroundColor = [119, 119, 119];
    var backgroundColorCSS = '#' + backgroundColor.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    var backgroundColorGLSL = 'vec4(' + backgroundColor.map(function (v) { return v / 255; }).join(', ') + ', 1.0)';
    
    // TODO: Instead of hardcoding this, implement dynamic resizing of the history buffers. Punting for now because reallocating the GL textures would be messy.
    var historyCount = Math.max(
      1024,
      config.element.nodeName === 'CANVAS' ? config.element.height : 0);
    
    var canvas;
    var cleared = true;
    function commonBeforeDraw(viewCenterFreq, draw) {
      view.n.listen(draw);
      canvas.style.marginLeft = view.freqToCSSLeft(view.leftFreq());
      canvas.style.width = view.freqToCSSLength(view.rightFreq() - view.leftFreq());
      
      // Set vertical canvas resolution
      var newHeight = Math.floor(Math.min(canvas.offsetHeight, historyCount));
      if (newHeight !== canvas.height) {
        canvas.height = newHeight;
        cleared = true;
      }
    }
    
    CanvasSpectrumWidget.call(this, config, buildGL, build2D);
    
    // TODO(kpreid): This is a horrible kludge and we should replace it by making the container into a widget which manages the layout of both views instead. Also making sure that in the pure-waterfall view the channel labels are moved to the waterfall side.
    var el = this.element;
    function layout() {
      var otherFlexValue = 100;
      var proportion = config.clientState.spectrum_split.depend(layout);
      var flexValue = otherFlexValue * proportion / (1.001 - proportion);
      el.style.flex = flexValue + ' ' + flexValue;
    }
    layout.scheduler = config.scheduler;
    layout();
    
    function buildGL(gl, buildProgram, draw) {
      canvas = self.element;

      var useFloatTexture =
        config.clientState.opengl_float.depend(config.rebuildMe) &&
        !!gl.getExtension('OES_texture_float');

      var vertexShaderSource = ''
        + 'attribute vec4 position;\n'
        + 'varying highp vec2 v_position;\n'
        + 'uniform highp float scroll;\n'
        + 'uniform highp float yScale;\n'
        + 'void main(void) {\n'
        + '  gl_Position = position;\n'
        + '  highp vec2 unitPos = (position.xy + vec2(1.0)) / 2.0;\n'
        + '  highp vec2 scalePos = 1.0 - (1.0 - unitPos) * vec2(1.0, yScale);\n'
        + '  v_position = scalePos + vec2(0.0, scroll);\n'
        + '}\n';
      var fragmentShaderSource = ''
        + 'uniform sampler2D data;\n'
        + 'uniform sampler2D centerFreqHistory;\n'
        + 'uniform sampler2D gradient;\n'
        + 'uniform mediump float gradientZero;\n'
        + 'uniform mediump float gradientScale;\n'
        + 'varying mediump vec2 v_position;\n'
        + 'uniform highp float currentFreq;\n'
        + 'uniform mediump float freqScale;\n'
        + 'uniform highp float textureRotation;\n'
        + 'void main(void) {\n'
        + '  highp vec2 texLookup = mod(v_position, 1.0);\n'
        + (useFloatTexture
              ? 'highp float historyFreq = texture2D(centerFreqHistory, texLookup).r;\n'
              : 'highp vec4 hFreqVec = texture2D(centerFreqHistory, texLookup);\n'
              + '  highp float historyFreq = ((hFreqVec.a * 255.0 * 256.0 + hFreqVec.b * 255.0) * 256.0 + hFreqVec.g * 255.0) * 256.0 + hFreqVec.r * 255.0;\n')
        + '  highp float freqOffset = (currentFreq - historyFreq) * freqScale;\n'
        + '  mediump vec2 shift = texLookup + vec2(freqOffset, 0.0);\n'
        + '  if (shift.x < 0.0 || shift.x > 1.0) {\n'
        + '    gl_FragColor = ' + backgroundColorGLSL + ';\n'
        + '  } else {\n'
        + '    mediump float data = texture2D(data, shift + vec2(textureRotation, 0.0)).r;\n'
        + '    gl_FragColor = texture2D(gradient, vec2(0.5, gradientZero + gradientScale * data));\n'
        //+ '    gl_FragColor = texture2D(gradient, vec2(0.5, v_position.x));\n'
        //+ '    gl_FragColor = vec4(gradientZero + gradientScale * data * 4.0 - 0.5);\n'
        + '  }\n'
        + '}\n';
      var program = buildProgram(vertexShaderSource, fragmentShaderSource);
      
      var u_scroll = gl.getUniformLocation(program, 'scroll');
      var u_yScale = gl.getUniformLocation(program, 'yScale');
      var u_currentFreq = gl.getUniformLocation(program, 'currentFreq');
      var u_freqScale = gl.getUniformLocation(program, 'freqScale');
      var u_gradientZero = gl.getUniformLocation(program, 'gradientZero');
      var u_gradientScale = gl.getUniformLocation(program, 'gradientScale');
      var u_textureRotation = gl.getUniformLocation(program, 'textureRotation');
      
      var fftSize = Math.max(1, config.target.get().length);
      

      var bufferTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      var historyFreqTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, historyFreqTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      var gradientTexture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, gradientTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      (function() {
        var components = 4;
        // stretch = number of texels to generate per color. If we generate only the minimum and fully rely on hardware gl.LINEAR interpolation then certain pixels in the display tends to flicker as it scrolls, on some GPUs.
        var stretch = 10;
        var limit = (colors.length - 1) * stretch + 1;
        var gradientInit = new Uint8Array(limit * components);
        for (var i = 0; i < limit; i++) {
          interpolateColor(i / (limit - 1), gradientInit, i * 4);
        }

        gl.bindTexture(gl.TEXTURE_2D, gradientTexture);
        gl.texImage2D(
          gl.TEXTURE_2D,
          0, // level
          gl.RGBA, // internalformat
          1, // width
          gradientInit.length / components, // height
          0, // border
          gl.RGBA, // format
          gl.UNSIGNED_BYTE, // type
          gradientInit);

        // gradientZero and gradientScale set the scaling from data texture values to gradient texture coordinates
        // gradientInset is the amount to compensate for half-texel edges
        var gradientInset = 0.5 / (gradientInit.length / components);
        var insetZero = gradientInset;
        var insetScale = 1 - gradientInset * 2;
        var valueZero, valueScale;
        if (useFloatTexture) {
          var minLevel = config.view.minLevel;
          var maxLevel = config.view.maxLevel;
          valueScale = 1 / (maxLevel - minLevel);
          valueZero = valueScale * -minLevel;
        } else {
          valueZero = 0;
          valueScale = 1;
        }
        gl.uniform1f(u_gradientZero, insetZero + insetScale * valueZero);
        gl.uniform1f(u_gradientScale, insetScale * valueScale);
      }());

      gl.bindTexture(gl.TEXTURE_2D, null);

      function configureTexture() {
        // dependent on fftSize so updating it here works out.
        // Shift (with wrapping) the texture data by 1/2 minus half a bin width, to align the GL texels with the FFT bins.
        // TODO: The 0.5 cannot actually take effect correctly, because right now we use a canvas size equal to the FFT size. Change so that (in GL mode) we resize to the viewport, like the spectrum plot does.
        gl.uniform1f(u_textureRotation, config.view.isRealFFT() ? 0 : -(0.5 - 0.5/fftSize));
        
        if (useFloatTexture) {
          var init = new Float32Array(fftSize*historyCount);
          for (var i = 0; i < fftSize*historyCount; i++) {
            init[i] = -100;
          }
          gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0, // level
            gl.LUMINANCE, // internalformat
            fftSize, // width (= fft size)
            historyCount, // height (= history size)
            0, // border
            gl.LUMINANCE, // format
            gl.FLOAT, // type -- TODO use non-float textures if needed
            init);

          var init = new Float32Array(historyCount);
          for (var i = 0; i < historyCount; i++) {
            init[i] = -1e20;  // dummy value which we hope will not land within the viewport
          }
          gl.bindTexture(gl.TEXTURE_2D, historyFreqTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0, // level
            gl.LUMINANCE, // internalformat
            1, // width
            historyCount, // height (= history size)
            0, // border
            gl.LUMINANCE, // format
            gl.FLOAT, // type
            init);
        } else {
          var init = new Uint8Array(fftSize*historyCount*4);
          gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0, // level
            gl.LUMINANCE, // internalformat
            fftSize, // width (= fft size)
            historyCount, // height (= history size)
            0, // border
            gl.LUMINANCE, // format
            gl.UNSIGNED_BYTE, // type
            init);

          var init = new Uint8Array(historyCount*4);
          gl.bindTexture(gl.TEXTURE_2D, historyFreqTexture);
          gl.texImage2D(
            gl.TEXTURE_2D,
            0, // level
            gl.RGBA, // internalformat
            1, // width
            historyCount, // height (= history size)
            0, // border
            gl.RGBA, // format
            gl.UNSIGNED_BYTE,
            init);
        }

        gl.bindTexture(gl.TEXTURE_2D, null);
      }
      configureTexture();

      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'data'), 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, historyFreqTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'centerFreqHistory'), 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, gradientTexture);
      gl.uniform1i(gl.getUniformLocation(program, 'gradient'), 3);
      gl.activeTexture(gl.TEXTURE0);

      var slicePtr = 0;

      var freqWriteBuffer = useFloatTexture ? new Float32Array(1) : new Uint8Array(4);
      var intConversionBuffer, intConversionOut;
      
      return {
        newData: function (fftBundle) {
          var buffer = fftBundle[1];
          var bufferCenterFreq = fftBundle[0].freq;
          
          if (buffer.length === 0) {
            return;
          }
          
          if (buffer.length !== fftSize || !useFloatTexture && !intConversionBuffer) {
            fftSize = buffer.length;
            configureTexture();
            intConversionBuffer = useFloatTexture ? null : new Uint8ClampedArray(fftSize);
            intConversionOut = useFloatTexture ? null : new Uint8Array(intConversionBuffer.buffer);
          }
          if (canvas.width !== fftSize) {
            canvas.width = fftSize;
            cleared = true;
          }
          // height managed by commonBeforeDraw

          if (useFloatTexture) {
            gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
            gl.texSubImage2D(
                gl.TEXTURE_2D,
                0, // level
                0, // xoffset
                slicePtr, // yoffset
                fftSize,
                1,
                gl.LUMINANCE,
                gl.FLOAT,
                buffer);

            freqWriteBuffer[0] = bufferCenterFreq;
            gl.bindTexture(gl.TEXTURE_2D, historyFreqTexture);
            gl.texSubImage2D(
                gl.TEXTURE_2D,
                0, // level
                0, // xoffset
                slicePtr, // yoffset
                1,
                1,
                gl.LUMINANCE,
                gl.FLOAT,
                freqWriteBuffer);
          } else {
            gl.bindTexture(gl.TEXTURE_2D, bufferTexture);
            var minLevel = config.view.minLevel;
            var maxLevel = config.view.maxLevel;
            var cscale = 255 / (maxLevel - minLevel);
            for (var i = 0; i < fftSize; i++) {
              intConversionBuffer[i] = (buffer[i] - minLevel) * cscale;
            }
            gl.texSubImage2D(
                gl.TEXTURE_2D,
                0, // level
                0, // xoffset
                slicePtr, // yoffset
                fftSize,
                1,
                gl.LUMINANCE,
                gl.UNSIGNED_BYTE,
                intConversionOut);

            freqWriteBuffer[0] = (bufferCenterFreq >> 0) & 0xFF;
            freqWriteBuffer[1] = (bufferCenterFreq >> 8) & 0xFF;
            freqWriteBuffer[2] = (bufferCenterFreq >> 16) & 0xFF;
            freqWriteBuffer[3] = (bufferCenterFreq >> 24) & 0xFF;
            gl.bindTexture(gl.TEXTURE_2D, historyFreqTexture);
            gl.texSubImage2D(
                gl.TEXTURE_2D,
                0, // level
                0, // xoffset
                slicePtr, // yoffset
                1,
                1,
                gl.RGBA,
                gl.UNSIGNED_BYTE,
                freqWriteBuffer);
          }

          gl.bindTexture(gl.TEXTURE_2D, null);
          slicePtr = mod(slicePtr + 1, historyCount);
        },
        beforeDraw: function () {
          view.n.listen(draw);
          var viewCenterFreq = view.getCenterFreq();
          commonBeforeDraw(viewCenterFreq, draw);

          gl.viewport(0, 0, canvas.width, canvas.height);
          gl.uniform1f(u_scroll, slicePtr / historyCount);
          gl.uniform1f(u_yScale, canvas.height / historyCount);
          var fs = 1.0 / (view.rightFreq() - view.leftFreq());
          gl.uniform1f(u_freqScale, fs);
          gl.uniform1f(u_currentFreq, viewCenterFreq);

          cleared = false;
        }
      };
    }
    
    function build2D(ctx, draw) {
      canvas = self.element;
      
      // circular buffer of ImageData objects
      var slices = [];
      var slicePtr = 0;
      var lastDrawnCenterFreq = NaN;

      var performDraw = config.boundedFn(function performDrawImpl() {
        var h = canvas.height;
        var w = canvas.width;
        var viewCenterFreq = view.getCenterFreq();
        commonBeforeDraw(viewCenterFreq, draw);

        var buffer, bufferCenterFreq;
        if (dataToDraw) {
          buffer = dataToDraw[1];
          bufferCenterFreq = dataToDraw[0].freq;
          // rescale to discovered fft size
          var fftLength = buffer.length;
          if (canvas.width !== fftLength) {
            // assignment clears canvas
            canvas.width = w = fftLength;
            cleared = true;
            // reallocate
            slices = [];
            slicePtr = 0;
          }

          // can't draw with w=0
          if (w === 0) {
            return;
          }

          // Find slice to write into
          var ibuf;
          if (slices.length < historyCount) {
            slices.push([ibuf = ctx.createImageData(w, 1), bufferCenterFreq]);
          } else {
            var record = slices[slicePtr];
            slicePtr = mod(slicePtr + 1, historyCount);
            ibuf = record[0];
            record[1] = bufferCenterFreq;
          }

          // Generate image slice from latest FFT data.
          var xScale = fftLength / w;
          var xZero = view.isRealFFT() ? 0 : fftLength / 2;
          var cScale = 1 / (view.maxLevel - view.minLevel);
          var cZero = 1 - view.maxLevel * cScale;
          var data = ibuf.data;
          for (var x = 0; x < w; x++) {
            var base = x * 4;
            var i = Math.round(x * xScale + xZero);
            var colorVal = buffer[mod(i, fftLength)] * cScale + cZero;
            interpolateColor(colorVal, data, base);
          }
        }

        ctx.fillStyle = backgroundColorCSS;

        var offsetScale = w / (view.rightFreq() - view.leftFreq());
        if (dataToDraw && lastDrawnCenterFreq === viewCenterFreq && !cleared) {
          // Scroll
          ctx.drawImage(ctx.canvas, 0, 0, w, h-1, 0, 1, w, h-1);

          // fill background of new line, if needed
          if (bufferCenterFreq !== viewCenterFreq) {
            ctx.fillRect(0, 0, w, 1);
          }

          // Paint newest slice
          var offset = bufferCenterFreq - viewCenterFreq;
          ctx.putImageData(ibuf, Math.round(offset * offsetScale), 0);
        } else if (cleared || lastDrawnCenterFreq !== viewCenterFreq) {
          // Horizontal position changed, paint all slices onto canvas
          
          lastDrawnCenterFreq = viewCenterFreq;
          // fill background so scrolling is of an opaque image
          ctx.fillRect(0, 0, w, h);
          
          var sliceCount = slices.length;
          for (var i = sliceCount - 1; i >= 0; i--) {
            var slice = slices[mod(i + slicePtr, sliceCount)];
            var offset = slice[1] - viewCenterFreq;
            var y = sliceCount - i - 1;
            if (y >= canvas.height) break;

            // paint slice
            ctx.putImageData(slice[0], Math.round(offset * offsetScale), y);
          }
          ctx.fillRect(0, y+1, w, h);
        }

        dataToDraw = null;
        cleared = false;
      });

      var dataToDraw = null;  // TODO this is a data flow kludge
      return {
        newData: function (fftBundle) {
          dataToDraw = fftBundle;
          // The storage/scrolling logic is in performDraw, and we call it immediately to ensure every frame gets painted.
          // TODO: It would be more efficient to queue things so that if we _do_ have multiple frames to draw, we don't do multiple one-pixel scrolling steps
          performDraw();
        },
        performDraw: performDraw
      };
    }
  }
  widgets.WaterfallPlot = WaterfallPlot;

  function to_dB(x) {
    return Math.log(x) / (Math.LN10 / 10);
  }

  function ReceiverMarks(config) {
    /* does not use config.target */
    var view = config.view;
    var radioCell = config.radioCell;
    var others = config.index.implementing('shinysdr.top.IHasFrequency');
    
    var canvas = config.element;
    if (canvas.tagName !== 'CANVAS') {
      canvas = document.createElement('canvas');
      canvas.classList.add('overlay');
    }
    this.element = canvas;
    
    var ctx = canvas.getContext('2d');
    var textOffsetFromTop =
        //ctx.measureText('j').fontBoundingBoxAscent; -- not yet supported
        10 + 2; // default font size is "10px", ignoring effect of baseline
    var textSpacing = 10 + 1;
    
    // Drawing parameters and functions
    // Each variable is updated in draw()
    // This is done so that the functions need not be re-created
    // each frame.
    var w, h, lvf, rvf;
    function freqToCoord(freq) {
      return (freq - lvf) / (rvf-lvf) * w;
    }
    function drawHair(freq) {
      var x = freqToCoord(freq);
      x = Math.floor(x) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, ctx.canvas.height);
      ctx.stroke();
    }
    function drawBand(freq1, freq2) {
      var x1 = freqToCoord(freq1);
      var x2 = freqToCoord(freq2);
      ctx.fillRect(x1, 0, x2 - x1, ctx.canvas.height);
    }
    
    var draw = config.boundedFn(function drawImpl() {
      view.n.listen(draw);
      lvf = view.leftVisibleFreq();
      rvf = view.rightVisibleFreq();
      var yScale = -h / (view.maxLevel - view.minLevel);
      var yZero = -view.maxLevel * yScale;
      
      canvas.style.marginLeft = view.freqToCSSLeft(lvf);
      w = canvas.offsetWidth;
      h = canvas.offsetHeight;
      if (canvas.width !== w || canvas.height !== h) {
        // implicitly clears
        canvas.width = w;
        canvas.height = h;
      } else {
        ctx.clearRect(0, 0, w, h);
      }
      
      ctx.strokeStyle = 'gray';
      drawHair(view.getCenterFreq()); // center frequency
      
      others.depend(draw).forEach(function (object) {
        ctx.strokeStyle = 'green';
        drawHair(object.freq.depend(draw));
      });
      
      var receivers = radioCell.depend(draw).receivers.depend(draw);
      receivers._reshapeNotice.listen(draw);
      for (var recKey in receivers) {
        var receiver = receivers[recKey].depend(draw);
        var rec_freq_cell = receiver.rec_freq;
        var rec_freq_now = rec_freq_cell.depend(draw);
        var band_filter_cell = receiver.demodulator.depend(draw).band_filter_shape;
        if (band_filter_cell) {
          var band_filter_now = band_filter_cell.depend(draw);
        }

        if (band_filter_now) {
          var fl = band_filter_now.low;
          var fh = band_filter_now.high;
          var fhw = band_filter_now.width / 2;
          ctx.fillStyle = '#3A3A3A';
          drawBand(rec_freq_now + fl - fhw, rec_freq_now + fh + fhw);
          ctx.fillStyle = '#444444';
          drawBand(rec_freq_now + fl + fhw, rec_freq_now + fh - fhw);
        }

        // TODO: marks ought to be part of a distinct widget
        var squelch_threshold_cell = receiver.demodulator.depend(draw).squelch_threshold;
        if (squelch_threshold_cell) {
          var squelchPower = squelch_threshold_cell.depend(draw);
          var squelchL, squelchR, bandwidth;
          if (band_filter_now) {
            squelchL = freqToCoord(rec_freq_now + band_filter_now.low);
            squelchR = freqToCoord(rec_freq_now + band_filter_now.high);
            bandwidth = band_filter_now.high - band_filter_now.low;
          } else {
            // dummy
            squelchL = 0;
            squelchR = w;
            bandwidth = 10e3;
          }
          var squelchPSD = squelchPower - to_dB(bandwidth);
          var squelchY = Math.floor(yZero + squelchPSD * yScale) + 0.5;
          var minSquelchHairWidth = 30;
          if (squelchR - squelchL < minSquelchHairWidth) {
            var squelchMid = (squelchR + squelchL) / 2;
            squelchL = squelchMid - minSquelchHairWidth/2;
            squelchR = squelchMid + minSquelchHairWidth/2;
          }
          ctx.strokeStyle = '#F00';
          ctx.beginPath();
          ctx.moveTo(squelchL, squelchY);
          ctx.lineTo(squelchR, squelchY);
          ctx.stroke();
        }

        ctx.strokeStyle = 'white';
        drawHair(rec_freq_now); // receiver
        ctx.fillStyle = 'white';
        var textX = freqToCoord(rec_freq_now) + 2;
        var textY = textOffsetFromTop - textSpacing;

        ctx.fillText(recKey, textX, textY += textSpacing);
        ctx.fillText(formatFreqExact(receiver.rec_freq.depend(draw)), textX, textY += textSpacing);
        ctx.fillText(receiver.mode.depend(draw), textX, textY += textSpacing);
      }
    });
    draw.scheduler = config.scheduler;
    config.scheduler.enqueue(draw);  // must draw after widget inserted to get proper layout
  }
  widgets.ReceiverMarks = ReceiverMarks;
  
  function Knob(config) {
    var target = config.target;

    var type = target.type;
    // TODO: use integer flag of Range, w decimal points?
    function clamp(value, direction) {
      if (type instanceof values.Range) {  // TODO: better type protocol
        return type.round(value, direction);
      } else {
        return value;
      }
    }
    
    var container = document.createElement('span');
    container.classList.add('widget-Knob-outer');
    
    if (config.shouldBePanel) {
      var panel = document.createElement('div');
      panel.classList.add('panel');
      if (config.element.hasAttribute('title')) {
        panel.appendChild(document.createTextNode(config.element.getAttribute('title')));
        config.element.removeAttribute('title');
      }
      panel.appendChild(container);
      this.element = panel;
    } else {
      this.element = container;
    }
    
    var places = [];
    var marks = [];
    for (var i = 9; i >= 0; i--) (function(i) {
      if (i % 3 == 2) {
        var mark = container.appendChild(document.createElement("span"));
        mark.className = "knob-mark";
        mark.textContent = ",";
        //mark.style.visibility = "hidden";
        marks.unshift(mark);
        // TODO: make marks responsive to scroll events (doesn't matter which neighbor, or split in the middle, as long as they do something).
      }
      var digit = container.appendChild(document.createElement("span"));
      digit.className = "knob-digit";
      digit.tabIndex = -1;
      var digitText = digit.appendChild(document.createTextNode('0'));
      places[i] = {element: digit, text: digitText};
      var scale = Math.pow(10, i);
      function spin(direction) {
        target.set(clamp(direction * scale + target.get(), direction));
      }
      digit.addEventListener("mousewheel", function(event) { // Not in FF
        // TODO: deal with high-res/accelerated scrolling
        spin(event.wheelDelta > 0 ? 1 : -1);
        event.preventDefault();
        event.stopPropagation();
      }, true);
      function focusNext() {
        if (i > 0) {
          places[i - 1].element.focus();
        } else {
          //digit.blur();
        }
      }
      function focusPrev() {
        if (i < places.length - 1) {
          places[i + 1].element.focus();
        } else {
          //digit.blur();
        }
      }
      digit.addEventListener('keydown', function(event) {
        switch (event.keyCode) {  // nominally poorly compatible, but best we can do
          case 0x08: // backspace
          case 0x25: // left
            focusPrev();
            break;
          case 0x27: // right
            focusNext();
            break;
          case 0x26: // up
            spin(1);
            break;
          case 0x28: // down
            spin(-1);
            break;
          default:
            return;
        }
        event.preventDefault();
        event.stopPropagation();
      }, true);
      digit.addEventListener('keypress', function(event) {
        var ch = String.fromCharCode(event.charCode);
        var value = target.get();
        
        switch (ch) {
          case '-':
          case '_':
            target.set(-Math.abs(value));
            return;
          case '+':
          case '=':
            target.set(Math.abs(value));
            return;
          case 'z':
          case 'Z':
            // zero all digits here and to the right
            // | 0 is used to round towards zero
            var zeroFactor = scale * 10;
            target.set(((value / zeroFactor) | 0) * zeroFactor);
            return;
          default:
            break;
        }
        
        // TODO I hear there's a new 'input' event which is better for input-ish keystrokes, use that
        var input = parseInt(ch, 10);
        if (isNaN(input)) return;

        var negative = value < 0 || (value === 0 && 1/value === -Infinity);
        if (negative) { value = -value; }
        var currentDigitValue;
        if (scale === 1) {
          // When setting last digit, clear any hidden fractional digits as well
          currentDigitValue = (value / scale) % 10;
        } else {
          currentDigitValue = Math.floor(value / scale) % 10;
        }
        value += (input - currentDigitValue) * scale;
        if (negative) { value = -value; }
        target.set(clamp(value, 0));

        focusNext();
        event.preventDefault();
        event.stopPropagation();
      });
      
      // remember last place for tabbing
      digit.addEventListener('focus', function (event) {
        places.forEach(function (other) {
          other.element.tabIndex = -1;
        });
        digit.tabIndex = 0;
      }, false);
      
      // spin buttons
      digit.style.position = 'relative';
      [-1, 1].forEach(function (direction) {
        var up = direction > 0;
        var layoutShim = digit.appendChild(document.createElement('span'));
        layoutShim.className = 'knob-spin-button-shim knob-spin-' + (up ? 'up' : 'down');
        var button = layoutShim.appendChild(document.createElement('button'));
        button.className = 'knob-spin-button knob-spin-' + (up ? 'up' : 'down');
        button.textContent = up ? '+' : '-';
        function pushListener(event) {
          spin(direction);
          event.preventDefault();
          event.stopPropagation();
        }
        // Using these events instead of click event allows the button to work despite the auto-hide-on-focus-loss, in Chrome.
        button.addEventListener('touchstart', pushListener, false);
        button.addEventListener('mousedown', pushListener, false);
        //button.addEventListener('click', pushListener, false);
        // If in the normal tab order, its appearing/disappearing causes trouble
        button.tabIndex = -1;
      });
    }(i));
    
    places[places.length - 1].element.tabIndex = 0; // initial tabbable digit
    
    var draw = config.boundedFn(function drawImpl() {
      var value = target.depend(draw);
      var valueStr = String(Math.round(value));
      if (valueStr === '0' && value === 0 && 1/value === -Infinity) {
        // allow user to see progress in entering negative values
        valueStr = '-0';
      }
      var last = valueStr.length - 1;
      for (var i = 0; i < places.length; i++) {
        var digit = valueStr[last - i];
        places[i].text.data = digit || '0';
        places[i].element.classList[digit ? 'remove' : 'add']('knob-dim');
      }
      var numMarks = Math.floor((valueStr.replace("-", "").length - 1) / 3);
      for (var i = 0; i < marks.length; i++) {
        marks[i].classList[i < numMarks ? 'remove' : 'add']('knob-dim');
      }
    });
    draw.scheduler = config.scheduler;
    draw();
  }
  widgets.Knob = Knob;
  
  // "exact" as in doesn't drop digits
  function formatFreqExact(freq) {
    var a = Math.abs(freq);
    if (a < 1e3) {
      return String(freq);
    } else if (a < 1e6) {
      return freq / 1e3 + 'k';
    } else if (a < 1e9) {
      return freq / 1e6 + 'M';
    } else {
      return freq / 1e9 + 'G';
    }
  }
  
  // minimal ES-Harmony shim for use by VisibleItemCache
  // O(n) but fast
  var Map = window.Map || (function() {
    function Map() {
      this._keys = [];
      this._values = [];
    }
    Map.prototype.delete = function (key) {
      var i = this._keys.indexOf(key);
      if (i >= 0) {
        var last = this._keys.length - 1;
        if (i < last) {
          this._keys[i] = this._keys[last];
          this._values[i] = this._values[last];
        }
        this._keys.length = last;
        this._values.length = last;
        return true;
      } else {
        return false;
      }
    };
    Map.prototype.get = function (key) {
      var i = this._keys.indexOf(key);
      if (i >= 0) {
        return this._values[i];
      } else {
        return undefined;
      }
    };
    Map.prototype.set = function (key, value) {
      var i = this._keys.indexOf(key);
      if (i >= 0) {
        this._values[i] = value;
      } else {
        this._keys.push(key);
        this._values.push(value);
      }
    };
    Object.defineProperty(Map.prototype, 'size', {
      get: function () {
        return this._keys.length;
      }
    });
    return Map;
  }());
  
  // Keep track of elements corresponding to keys and insert/remove as needed
  // maker() returns an element or falsy
  function VisibleItemCache(parent, maker) {
    var cache = new Map();
    var count = 0;
    
    this.add = function(key) {
      count++;
      var element = cache.get(key);
      if (!element) {
        element = maker(key);
        if (!element) {
          return;
        }
        parent.appendChild(element);
        element.my_cacheKey = key;
        cache.set(key, element);
      }
      if (!element.parentNode) throw new Error('oops');
      element.my_inUse = true;
      return element;
    };
    this.flush = function() {
      var active = parent.childNodes;
      for (var i = active.length - 1; i >= 0; i--) {
        var element = active[i];
        if (element.my_inUse) {
          element.my_inUse = false;
        } else {
          parent.removeChild(element);
          if (!'my_cacheKey' in element) throw new Error('oops2');
          cache.delete(element.my_cacheKey);
        }
      }
      if (active.length !== count || active.length !== cache.size) throw new Error('oops3');
      count = 0;
    };
  }
  
  // A collection/algorithm which allocates integer indexes to provided intervals such that no overlapping intervals have the same index.
  // Intervals are treated as open, unless the endpoints are equal in which case they are treated as closed (TODO: slightly inconsistently but it doesn't matter for the application).
  function IntervalStacker() {
    this._elements = [];
  }
  IntervalStacker.prototype.clear = function () {
    this._elements.length = 0;
  };
  // Find index of value in the array, or index to insert at
  IntervalStacker.prototype._search1 = function (position) {
    // if it turns out to matter, replace this with a binary search
    var array = this._elements;
    for (var i = 0; i < array.length; i++) {
      if (array[i].key >= position) return i;
    }
    return i;
  };
  IntervalStacker.prototype._ensure1 = function (position, which) {
    var index = this._search1(position);
    var el = this._elements[index];
    if (!(el && el.key === position)) {
      // insert
      var newEl = {key: position, below: Object.create(null), above: Object.create(null)};
      // insert neighbors' info
      var lowerNeighbor = this._elements[index - 1];
      if (lowerNeighbor) {
        Object.keys(lowerNeighbor.above).forEach(function (value) {
          newEl.below[value] = newEl.above[value] = true;
        });
      }
      var upperNeighbor = this._elements[index + 1];
      if (upperNeighbor) {
        Object.keys(upperNeighbor.below).forEach(function (value) {
          newEl.below[value] = newEl.above[value] = true;
        });
      }
      
      // TODO: if it turns out to be worthwhile, use a more efficient insertion
      this._elements.push(newEl);
      this._elements.sort(function (a, b) { return a.key - b.key; });
      var index2 = this._search1(position);
      if (index2 !== index) throw new Error('assumption violated');
      if (this._elements[index].key !== position) { debugger; throw new Error('assumption2 violated'); }
    }
    return index;
  };
  // Given an interval, which may be zero-length, claim and return the lowest index (>= 0) which has not previously been used for an overlapping interval.
  IntervalStacker.prototype.claim = function (low, high) {
    // TODO: Optimize by not _storing_ zero-length intervals
    // note must be done in this order to not change the low index
    var lowIndex = this._ensure1(low);
    var highIndex = this._ensure1(high);
    //console.log(this._elements.map(function(x){return x.key;}), lowIndex, highIndex);
    
    for (var value = 0; value < 1000; value++) {
      var free = true;
      for (var i = lowIndex; i <= highIndex; i++) {
        var element = this._elements[i];
        if (i > lowIndex || lowIndex === highIndex) {
          free = free && !element.below[value];
        }
        if (i < highIndex || lowIndex === highIndex) {
          free = free && !element.above[value];
        }
      }
      if (!free) continue;
      for (var i = lowIndex; i <= highIndex; i++) {
        var element = this._elements[i];
        if (i > lowIndex) {
          element.below[value] = true;
        }
        if (i < highIndex) {
          element.above[value] = true;
        }
      }
      return value;
    }
    return null;
  };
  
  function FreqScale(config) {
    var tunerSource = config.target;
    var radioCell = config.radioCell;
    var dataSource = config.freqDB.groupSameFreq();
    var view = config.view;

    // cache query
    var query, qLower = NaN, qUpper = NaN;

    var labelWidth = 60; // TODO actually measure styled text
    
    // view parameters closed over
    var lower, upper;
    
    
    var stacker = new IntervalStacker();
    function pickY(lowerFreq, upperFreq) {
      return (stacker.claim(lowerFreq, upperFreq) + 1) * 1.15;
    }

    var outer = this.element = document.createElement("div");
    outer.className = "freqscale";
    var numbers = outer.appendChild(document.createElement('div'));
    numbers.className = 'freqscale-numbers';
    var labels = outer.appendChild(document.createElement('div'));
    labels.className = 'freqscale-labels';
    
    // label maker fns
    function addChannel(record) {
      var group = record.type === 'group';
      var channel = group ? record.grouped[0] : record;
      var freq = record.freq;
      var mode = channel.mode;
      var el = document.createElement('span');
      el.className = 'freqscale-channel';
      el.textContent =
        (group ? '(' + record.grouped.length + ') ' : '')
        + (channel.label || channel.mode);
      // TODO: be an <a> or <button>
      el.addEventListener('click', function(event) {
        if (alwaysCreateReceiverFromEvent(event)) {
          radioCell.get().tune({
            record: channel,
            alwaysCreate: true
          });
        } else {
          radioCell.get().preset.set(channel);
        }
        event.stopPropagation();
      }, false);
      el.my_update = function() {
        el.style.left = view.freqToCSSLeft(freq);
        // TODO: the 2 is a fudge factor
        el.style.bottom = (pickY(freq, freq) - 2) + 'em';
      };
      return el;
    }
    function addBand(record) {
      var el = document.createElement('span');
      el.className = 'freqscale-band';
      el.textContent = record.label || record.mode;
      el.my_update = function() {
        var labelLower = Math.max(record.lowerFreq, lower);
        var labelUpper = Math.min(record.upperFreq, upper);
        el.style.left = view.freqToCSSLeft(labelLower);
        el.style.width = view.freqToCSSLength(labelUpper - labelLower);
        el.style.bottom = pickY(record.lowerFreq, record.upperFreq) + 'em';
      }
      return el;
    }

    var numberCache = new VisibleItemCache(numbers, function (freq) {
      var label = document.createElement('span');
      label.className = 'freqscale-number';
      label.textContent = formatFreqExact(freq);
      label.my_update = function() {
        label.style.left = view.freqToCSSLeft(freq);
      }
      return label;
    });
    var labelCache = new VisibleItemCache(labels, function makeLabel(record) {
      switch (record.type) {
        case 'group':
        case 'channel':
          return addChannel(record);
        case 'band':
          return addBand(record);
      }
    });
    
    var scale_coarse = 10;
    var scale_fine1 = 4;
    var scale_fine2 = 2;
    
    var draw = config.boundedFn(function drawImpl() {
      var centerFreq = tunerSource.depend(draw);
      view.n.listen(draw);
      
      lower = view.leftFreq();
      upper = view.rightFreq();
      
      // TODO: identical to waterfall's use, refactor
      outer.style.marginLeft = view.freqToCSSLeft(lower);
      outer.style.width = view.freqToCSSLength(upper - lower);
      
      // Minimum spacing between labels in Hz
      var MinHzPerLabel = (upper - lower) * labelWidth / view.getTotalPixelWidth();
      
      var step = 1;
      // Widen label spacing exponentially until they have sufficient separation.
      // We could try to calculate the step using logarithms, but floating-point error would be tiresome.
      while (isFinite(step) && step < MinHzPerLabel) {
        step *= scale_coarse;
      }
      // Try to narrow the spacing using two possible fine scales.
      if (step / scale_fine1 > MinHzPerLabel) {
        step /= scale_fine1;
      } else if (step / scale_fine2 > MinHzPerLabel) {
        step /= scale_fine2;
      }
      
      for (var i = lower - mod(lower, step), sanity = 1000;
           sanity > 0 && i <= upper;
           sanity--, i += step) {
        numberCache.add(i).my_update();
      }
      numberCache.flush();
      
      stacker.clear();
      if (!(lower === qLower && upper === qUpper)) {
        query = dataSource.inBand(lower, upper);
        qLower = lower;
        qUpper = upper;
      }
      query.n.listen(draw);
      query.forEach(function (record) {
        var label = labelCache.add(record);
        if (label) label.my_update();
      });
      labelCache.flush();
    });
    draw.scheduler = config.scheduler;
    draw();
  }
  widgets.FreqScale = FreqScale;
  
  function FreqList(config) {
    var radioCell = config.radioCell;
    var scheduler = config.scheduler;
    var configKey = 'filterString';
    
    // TODO recognize hardware limits somewhere central
    // TODO should be union of 0-samplerate and 15e6-...
    var dataSource = config.freqDB.inBand(0, 2200e6); 
    
    var container = this.element = document.createElement('div');
    container.classList.add('panel');
    
    var filterBox = container.appendChild(document.createElement('input'));
    filterBox.type = 'search';
    filterBox.placeholder = 'Filter channels...';
    filterBox.value = config.storage.getItem(configKey) || '';
    filterBox.addEventListener('input', refilter, false);
    
    var listOuter = container.appendChild(document.createElement('div'))
    listOuter.className = 'freqlist-box';
    var list = listOuter.appendChild(document.createElement('table'))
      .appendChild(document.createElement('tbody'));
    
    var receiveAllButton = container.appendChild(document.createElement('button'));
    receiveAllButton.textContent = 'Receive all in search';
    receiveAllButton.addEventListener('click', function (event) {
      var receivers = radioCell.get().recevers.get();
      for (var key in receivers) {
        receivers.delete(key);
      }
      currentFilter.forEach(function(p) {
        radioCell.get().tune({
          freq: p.freq,
          mode: p.mode,
          alwaysCreate: true
        });
      });
    }, false);
    
    function getElementForRecord(record) {
      // TODO caching should be a WeakMap when possible
      if (record._view_element) {
        record._view_element._sdr_drawHook();
        return record._view_element;
      }
      
      var item = document.createElement('tr');
      var drawFns = [];
      function cell(className, textFn) {
        var td = item.appendChild(document.createElement('td'));
        td.className = 'freqlist-cell-' + className;
        drawFns.push(function() {
          td.textContent = textFn();
        });
      }
      record._view_element = item;
      switch (record.type) {
        case 'channel':
          cell('freq', function () { return (record.freq / 1e6).toFixed(2); });
          cell('mode', function () { return record.mode === 'ignore' ? '' : record.mode;  });
          cell('label', function () { 
            var notes = record.notes;
            return notes.indexOf(record.label) === 0 /* TODO KLUDGE for current sloppy data sources */ ? notes : record.label;
          });
          drawFns.push(function () {
            item.title = record.notes;
          });
          break;
        case 'band':
        default:
          break;
      }
      if (!(record.mode in allModes)) {
        item.classList.add('freqlist-item-unsupported');
      }
      item.addEventListener('click', function(event) {
        radioCell.get().preset.set(record);
        event.stopPropagation();
      }, false);
      
      function draw() {
        drawFns.forEach(function (f) { f(); });
        if (record.offsetWidth > 0) { // rough 'is in DOM tree' test
          record.n.listen(draw);
        }
      }
      draw.scheduler = scheduler;
      item._sdr_drawHook = draw;
      draw();
      
      return item;
    }
    
    var currentFilter = dataSource;
    var lastFilterText = null;
    function refilter() {
      if (lastFilterText !== filterBox.value) {
        lastFilterText = filterBox.value;
        config.storage.setItem(configKey, lastFilterText);
        currentFilter = dataSource.string(lastFilterText).type('channel');
        draw();
      }
    }
    
    var draw = config.boundedFn(function drawImpl() {
      //console.group('draw');
      //console.log(currentFilter.getAll().map(function (r) { return r.label; }));
      currentFilter.n.listen(draw);
      //console.groupEnd();
      list.textContent = '';  // clear
      currentFilter.forEach(function (record) {
        list.appendChild(getElementForRecord(record));
      });
      // sanity check
      var count = currentFilter.getAll().length;
      receiveAllButton.disabled = !(count > 0 && count <= 10);
    });
    draw.scheduler = scheduler;

    refilter();
  }
  widgets.FreqList = FreqList;
  
  var NO_RECORD = {};
  function RecordCellPropCell(recordCell, prop) {
    this.get = function () {
      var record = recordCell.get();
      return record ? record[prop] : NO_RECORD;
    };
    this.set = function (value) {
      recordCell.get()[prop] = value;
    };
    this.isWritable = function () {
      return recordCell.get().writable;
    };
    this.n = {
      listen: function (l) {
        var now = recordCell.get();
        if (now) now.n.listen(l);
        recordCell.n.listen(l);
      }
    };
  }
  RecordCellPropCell.prototype = Object.create(Cell.prototype, {constructor: {value: RecordCellPropCell}});
  
  function RecordDetails(config) {
    var recordCell = config.target;
    var scheduler = config.scheduler;
    var container = this.element = config.element;
    
    var inner = container.appendChild(document.createElement('div'));
    inner.className = 'RecordDetails-fields';
    
    function labeled(name, field) {
      var label = inner.appendChild(document.createElement('label'));
      
      var text = label.appendChild(document.createElement('span'));
      text.className = 'RecordDetails-labeltext';
      text.textContent = name;
      
      label.appendChild(field);
      return field;
    }
    function formFieldHooks(field, cell) {
      var draw = config.boundedFn(function drawImpl() {
        var now = cell.depend(draw);
        if (now === NO_RECORD) {
          field.disabled = true;
        } else {
          field.disabled = !cell.isWritable();
          if (field.value !== now) field.value = now;
        }
      });
      draw.scheduler = config.scheduler;
      field.addEventListener('change', function(event) {
        if (field.value !== cell.get()) {
          cell.set(field.value);
        }
      });
      draw();
    }
    function input(cell, name) {
      var field = document.createElement('input');
      formFieldHooks(field, cell);
      return labeled(name, field);
    }
    function menu(cell, name, values) {
      var field = document.createElement('select');
      for (var key in values) {
        var option = field.appendChild(document.createElement('option'));
        option.value = key;
        option.textContent = values[key];
      }
      formFieldHooks(field, cell);
      return labeled(name, field);
    }
    function textarea(cell) {
      var field = container.appendChild(document.createElement('textarea'));
      formFieldHooks(field, cell);
      return field;
    }
    function cell(prop) {
      return new RecordCellPropCell(recordCell, prop);
    }
    menu(cell('type'), 'Type', {'channel': 'Channel', 'band': 'Band'});
    input(cell('freq'), 'Freq');  // TODO add lowerFreq/upperFreq display
    menu(cell('mode'), 'Mode', allModes);
    input(cell('location'), 'Location').readOnly = true;  // can't edit yet
    input(cell('label'), 'Label');
    textarea(cell('notes'));
  }
  widgets.RecordDetails = RecordDetails;
  
  // Silly single-purpose widget 'till we figure out more where the UI is going
  function SaveButton(config) {
    var radioCell = config.radioCell;
    var receiver = config.target.get();
    var panel = this.element = config.element;
    panel.classList.add('panel');
    
    var button = panel.querySelector('button');
    if (!button) {
      button = panel.appendChild(document.createElement('button'));
      button.textContent = '+ Save to database';
    }
    button.disabled = false;
    button.onclick = function (event) {
      var record = {
        type: 'channel',
        freq: receiver.rec_freq.get(),
        mode: receiver.mode.get(),
        label: 'untitled'
      };
      radioCell.get().preset.set(config.writableDB.add(record));
    };
  }
  widgets.SaveButton = SaveButton;
  
  // TODO: lousy name
  // This abstract widget class is for widgets which use an INPUT or similar element and optionally wrap it in a panel.
  function SimpleElementWidget(config, expectedNodeName, buildPanel, initDataEl, update) {
    var target = config.target;
    
    var dataElement;
    if (config.element.nodeName !== expectedNodeName) {
      var container = this.element = config.element;
      if (config.shouldBePanel) container.classList.add('panel');
      dataElement = buildPanel(container);
    } else {
      this.element = dataElement = config.element;
    }
    
    var update = initDataEl(dataElement, target);
    
    var draw = config.boundedFn(function drawImpl() {
      var value = target.depend(draw);
      update(value);
    });
    draw.scheduler = config.scheduler;
    draw();
  }
  
  function Generic(config) {
    SimpleElementWidget.call(this, config, undefined,
      function buildPanel(container) {
        container.appendChild(document.createTextNode(container.getAttribute('title') + ': '));
        container.removeAttribute('title');
        return container.appendChild(document.createTextNode(''));
      },
      function init(node, target) {
        return function updateGeneric(value) {
          node.textContent = value;
        };
      });
  }
  widgets.Generic = Generic;
  
  // widget for Notice type
  function Banner(config) {
    var type = config.target.type;
    var alwaysVisible = type instanceof Notice && type.alwaysVisible;  // TODO something better than instanceof...?
    
    var textNode = document.createTextNode('');
    SimpleElementWidget.call(this, config, undefined,
      function buildPanel(container) {
        // TODO: use title in some way
        container.appendChild(textNode);
        return container;
      },
      function init(node, target) {
        return function updateGeneric(value) {
          value = String(value);
          textNode.textContent = value;
          var active = value !== '';
          if (active) {
            node.classList.add('widget-Banner-active');
          } else {
            node.classList.remove('widget-Banner-active');
          }
          if (active || alwaysVisible) {
            node.classList.remove('widget-Banner-hidden');
          } else {
            node.classList.add('widget-Banner-hidden');
          }
        };
      });
  }
  widgets.Banner = Banner;
  
  function NumberWidget(config) {
    SimpleElementWidget.call(this, config, 'TT',
      function buildPanel(container) {
        if (config.shouldBePanel) {
          container.appendChild(document.createTextNode(container.getAttribute('title') + ': '));
          container.removeAttribute('title');
          return container.appendChild(document.createElement('tt'));
        } else {
          return container;
        }
      },
      function init(container, target) {
        var textNode = container.appendChild(document.createTextNode(''));
        return function updateGeneric(value) {
          textNode.textContent = (+value).toFixed(2);
        };
      });
  }
  widgets.Number = NumberWidget;
  
  function SmallKnob(config) {
    SimpleElementWidget.call(this, config, 'INPUT',
      function buildPanelForSmallKnob(container) {
        container.classList.add('widget-SmallKnob-panel');
        
        if (container.hasAttribute('title')) {
          var labelEl = container.appendChild(document.createElement('span'));
          labelEl.classList.add('widget-SmallKnob-label');
          labelEl.appendChild(document.createTextNode(container.getAttribute('title')));
          container.removeAttribute('title');
        }
        
        var input = container.appendChild(document.createElement('input'));
        input.type = 'number';
        input.step = 'any';
        
        return input;
      },
      function initSmallKnob(input, target) {
        var type = target.type;
        if (type instanceof values.Range) {
          input.min = getT(type.getMin());
          input.max = getT(type.getMax());
          input.step = (type.integer && !type.logarithmic) ? 1 : 'any';
        }

        input.addEventListener('change', function(event) {
          if (type instanceof values.Range) {
            target.set(type.round(input.valueAsNumber, 0));
          } else {
            target.set(input.valueAsNumber);
          }
        }, false);
        
        return function updateSmallKnob(value) {
          var sValue = +value;
          if (!isFinite(sValue)) {
            sValue = 0;
          }
          input.disabled = false;
          input.valueAsNumber = sValue;
        }
      });
  }
  widgets.SmallKnob = SmallKnob;
  
  function Slider(config, getT, setT) {
    var text;
    SimpleElementWidget.call(this, config, 'INPUT',
      function buildPanelForSlider(container) {
        container.classList.add('widget-Slider-panel');
        
        if (container.hasAttribute('title')) {
          var labelEl = container.appendChild(document.createElement('span'));
          labelEl.classList.add('widget-Slider-label');
          labelEl.appendChild(document.createTextNode(container.getAttribute('title')));
          container.removeAttribute('title');
        }
        
        var slider = container.appendChild(document.createElement('input'));
        slider.type = 'range';
        slider.step = 'any';
        
        var textEl = container.appendChild(document.createElement('span'));
        textEl.classList.add('widget-Slider-text');
        text = textEl.appendChild(document.createTextNode(''));
        
        return slider;
      },
      function initSlider(slider, target) {
        var format = function(n) { return n.toFixed(2); };

        var type = target.type;
        if (type instanceof values.Range) {
          slider.min = getT(type.getMin());
          slider.max = getT(type.getMax());
          slider.step = (type.integer) ? 1 : 'any';
          if (type.integer) {
            format = function(n) { return '' + n; };
          }
        }

        function listener(event) {
          if (type instanceof values.Range) {
            target.set(type.round(setT(slider.valueAsNumber), 0));
          } else {
            target.set(setT(slider.valueAsNumber));
          }
        }
        // Per HTML5 spec, dragging fires 'input', but not 'change', event. However Chrome only recently (observed 2014-04-12) got this right, so we had better listen to both.
        slider.addEventListener('change', listener, false);
        slider.addEventListener('input', listener, false);  
        return function updateSlider(value) {
          var sValue = getT(value);
          if (!isFinite(sValue)) {
            sValue = 0;
          }
          slider.disabled = false;
          slider.valueAsNumber = sValue;
          if (text) {
            text.data = format(value);
          }
        };
      });
  }
  var LinSlider = widgets.LinSlider = function(c) { return new Slider(c,
    function (v) { return v; },
    function (v) { return v; }); };
  var LogSlider = widgets.LogSlider = function(c) { return new Slider(c,
    function (v) { return Math.log(v) / Math.LN2; },
    function (v) { return Math.pow(2, v); }); };

  function Meter(config) {
    var text;
    SimpleElementWidget.call(this, config, 'METER',
      function buildPanelForMeter(container) {
        // TODO: Reusing styles for another widget -- rename to suit
        container.classList.add('widget-Slider-panel');
        
        if (container.hasAttribute('title')) {
          var labelEl = container.appendChild(document.createElement('span'));
          labelEl.classList.add('widget-Slider-label');
          labelEl.appendChild(document.createTextNode(container.getAttribute('title')));
          container.removeAttribute('title');
        }
        
        var meter = container.appendChild(document.createElement('meter'));
        
        var textEl = container.appendChild(document.createElement('span'));
        textEl.classList.add('widget-Slider-text');
        text = textEl.appendChild(document.createTextNode(''));
        
        return meter;
      },
      function initMeter(meter, target) {
        var format = function(n) { return n.toFixed(2); };
        
        var type = target.type;
        if (type instanceof values.Range) {
          meter.min = type.getMin();
          meter.max = type.getMax();
          if (type.integer) {
            format = function(n) { return '' + n; };
          }
        }
        
        return function updateMeter(value) {
          value = +value;
          meter.value = value;
          if (text) {
            text.data = format(value);
          }
        };
      });
  }
  widgets.Meter = Meter;
  
  function Toggle(config) {
    var text;
    SimpleElementWidget.call(this, config, 'INPUT',
      function buildPanelForToggle(container) {
        var label = container.appendChild(document.createElement('label'));
        var checkbox = label.appendChild(document.createElement('input'));
        checkbox.type = 'checkbox';
        label.appendChild(document.createTextNode(container.getAttribute('title')));
        container.removeAttribute('title');
        return checkbox;
      },
      function initToggle(checkbox, target) {
        checkbox.addEventListener('change', function(event) {
          target.set(checkbox.checked);
        }, false);
        return function updateToggle(value) {
          checkbox.checked = value;
        };
      });
  }
  widgets.Toggle = Toggle;
  
  // Create children of 'container' according to target's enum type, unless appropriate children already exist.
  function initEnumElements(container, selector, target, createElement) {
    var type = target.type;
    if (!(type instanceof values.Enum)) type = null;
    
    var seen = Object.create(null);
    Array.prototype.forEach.call(container.querySelectorAll(selector), function (element) {
      var value = element.value;
      seen[value] = true;
      if (type) {
        element.disabled = !(element.value in type.values);
      }
    });

    if (type) {
      var array = Object.keys(target.type.values || {});
      array.sort();
      array.forEach(function (value) {
        if (seen[value]) return;
        var element = createElement(type.values[value]);
        element.value = value;
      });
    }
  }
  
  function Select(config) {
    SimpleElementWidget.call(this, config, 'SELECT',
      function buildPanelForSelect(container) {
        //container.classList.add('widget-Popup-panel');
        
        // TODO: recurring pattern -- extract
        if (container.hasAttribute('title')) {
          var labelEl = container.appendChild(document.createElement('span'));
          labelEl.appendChild(document.createTextNode(container.getAttribute('title')));
          container.removeAttribute('title');
        }
        
        return container.appendChild(document.createElement('select'));
      },
      function initSelect(select, target) {
        initEnumElements(select, 'option', target, function createOption(name) {
          var option = select.appendChild(document.createElement('option'));
          option.appendChild(document.createTextNode(name));
          return option;
        })

        select.addEventListener('change', function(event) {
          target.set(select.value);
        }, false);
        
        return function updateSelect(value) {
          select.value = value;
        };
      });
  }
  widgets.Select = Select;
  
  function Radio(config) {
    var target = config.target;
    var container = this.element = config.element;
    container.classList.add('panel');

    initEnumElements(container, 'input[type=radio]', target, function createRadio(name) {
      var label = container.appendChild(document.createElement('label'));
      var rb = label.appendChild(document.createElement('input'));
      var textEl = label.appendChild(document.createElement('span'));  // styling hook
      textEl.textContent = name;
      rb.type = 'radio';
      if (!target.set) rb.disabled = true;
      return rb;
    });

    Array.prototype.forEach.call(container.querySelectorAll('input[type=radio]'), function (rb) {
      rb.addEventListener('change', function(event) {
        target.set(rb.value);
      }, false);
    });
    var draw = config.boundedFn(function drawImpl() {
      var value = config.target.depend(draw);
      Array.prototype.forEach.call(container.querySelectorAll('input[type=radio]'), function (rb) {
        rb.checked = rb.value === value;
      });
    });
    draw.scheduler = config.scheduler;
    draw();
  }
  widgets.Radio = Radio;
  
  // TODO: This is currently used by plugins to extend the widget namespace. Create a non-single-namespace widget type lookup and then freeze this.
  return widgets;
});
