/* eslint-env browser */

'use strict';

// Wrap the module in a universal module definition (UMD), allowing us to
// either include it as a <script> or to `require` it as a CommonJS module.
(function(root, initModule) {
  if (typeof exports === 'object') {
    module.exports = initModule;
  } else {
    initModule(root.ohm, root.ohmEditor, root.CheckedEmitter, window, root.document, root.cmUtil,
               root.d3, root.domUtil);
  }
})(this, function(ohm, ohmEditor, CheckedEmitter, window, document, cmUtil, d3, domUtil) {
  var ArrayProto = Array.prototype;
  var $ = domUtil.$;

  var UnicodeChars = {
    ANTICLOCKWISE_OPEN_CIRCLE_ARROW: '\u21BA',
    HORIZONTAL_ELLIPSIS: '\u2026',
    MIDDLE_DOT: '\u00B7'
  };

  var zoomState = {};

  var inputMark;
  var grammarMark;
  var defMark;

  var nextNodeId = 0;

  var parseResultsDiv = $('#parseResults');
  var inputCtx = $('#expandedInput').getContext('2d');

  // D3 Helpers
  // ----------

  function currentHeightPx(optEl) {
    return (optEl || this).offsetHeight + 'px';
  }

  function tweenWithCallback(endValue, cb) {
    return function tween(d, i, a) {
      var interp = d3.interpolate(a, endValue);
      return function(t) {
        var stepValue = interp.call(this, t);
        cb(t);
        return stepValue;
      };
    };
  }

  // Vue helpers
  // ----

  function addChildToVNode(vnode, child) {
    var children = vnode.componentOptions.children;
    if (!children) {
      children = vnode.componentOptions.children = [];
    }
    children.push(child);
  }

  // Parse tree helpers
  // ------------------

  function getFreshNodeId() {
    return 'node-' + nextNodeId++;
  }

  function isRectInViewport(rect) {
    return rect.right > 0 && rect.left < window.innerWidth;
  }

  function measureLabel(wrapperEl) {
    var tempWrapper = $('#measuringDiv .pexpr');
    var labelClone = wrapperEl.querySelector('.label').cloneNode(true);
    var clone = tempWrapper.appendChild(labelClone);
    var result = {
      width: clone.offsetWidth,
      height: clone.offsetHeight
    };
    tempWrapper.innerHTML = '';
    return result;
  }

  function measureChildren(wrapperEl) {
    var measuringDiv = $('#measuringDiv');
    var clone = measuringDiv.appendChild(wrapperEl.cloneNode(true));
    clone.style.width = '';
    var children = clone.lastChild;
    children.hidden = !children.hidden;
    var result = {
      width: children.offsetWidth,
      height: children.offsetHeight
    };
    measuringDiv.removeChild(clone);
    return result;
  }

  function getPixelRatio() {
    return window.devicePixelRatio || 1;
  }

  function measureInputText(text) {
    // Always update the font before measuring -- devicePixelRatio may have changed.
    inputCtx.font = 16 * getPixelRatio() + 'px Menlo, Monaco, monospace';
    return inputCtx.measureText(text).width / getPixelRatio();
  }

  function renderInputText(text, rect, optAlpha) {
    var textWidth = measureInputText(text);
    var letterPadding = (rect.right - rect.left - textWidth) / text.length / 2;
    var charWidth = textWidth / text.length;

    inputCtx.fillStyle = 'rgba(51, 51, 51, ' + (optAlpha == null ? 1 : optAlpha) + ')';
    inputCtx.textBaseline = 'top';

    var x = rect.left;
    for (var i = 0; i < text.length; i++) {
      x += letterPadding;
      inputCtx.fillText(text[i], x * getPixelRatio(), 0);
      x += charWidth + letterPadding;
    }
    return x <= window.innerWidth;
  }

  function renderHighlight(el) {
    var elBounds = el.getBoundingClientRect();
    var pixelRatio = getPixelRatio();
    var rect = {
      x: elBounds.left * pixelRatio,
      y: 0,
      width: (elBounds.right - elBounds.left) * pixelRatio,
      height: $('#expandedInput').height
    };
    inputCtx.fillStyle = '#B5D5FF';
    inputCtx.fillRect(rect.x, rect.y, rect.width, rect.height);
  }

  function clearMarks() {
    inputMark = cmUtil.clearMark(inputMark);
    grammarMark = cmUtil.clearMark(grammarMark);
    defMark = cmUtil.clearMark(defMark);
    ohmEditor.ui.grammarEditor.getWrapperElement().classList.remove('highlighting');
    ohmEditor.ui.inputEditor.getWrapperElement().classList.remove('highlighting');
  }

  // Hides or shows the children of `el`, which is a div.pexpr.
  function setTraceElementCollapsed(el, collapse, optDurationInMs) {
    var duration = optDurationInMs != null ? optDurationInMs : 500;

    function emitEvent() {
      el.classList.toggle('collapsed', collapse);
      ohmEditor.parseTree.emit((collapse ? 'collapse' : 'expand') + ':traceElement', el);
    }

    if (duration === 0) {
      el.lastChild.hidden = !collapse;
      emitEvent();
      el.lastChild.hidden = collapse;
      return;
    }

    var childrenSize = measureChildren(el);
    var newWidth = collapse ? measureLabel(el).width : childrenSize.width;

    d3.select(el)
        .transition().duration(duration)
        .styleTween('width', tweenWithCallback(newWidth + 'px', function(t) {
          updateExpandedInput(el, collapse, t);
        }))
        .each('start', function() {
          this.style.width = this.offsetWidth + 'px';
        })
        .each('end', function() {
          // Remove the width and allow the flexboxes to adjust to the correct
          // size. If there is a glitch when this happens, we haven't calculated
          // `newWidth` correctly.
          this.style.width = '';
        });

    var height = collapse ? 0 : childrenSize.height;
    d3.select(el.lastChild)
        .style('height', currentHeightPx)
        .transition().duration(duration)
        .style('height', height + 'px')
        .each('start', function() {
          if (!collapse) {
            emitEvent();
            this.hidden = false;
          }
        })
        .each('end', function() {
          this.style.height = '';
          if (collapse) {
            this.hidden = true;
            emitEvent();
          }
          updateExpandedInput();
        });
  }

  function updateZoomState(newState) {
    for (var k in newState) {
      if (newState.hasOwnProperty(k)) {
        zoomState[k] = newState[k];
      }
    }
//    refreshParseTree(rootTrace);
  }

  function clearZoomState() {
    zoomState = {};
    refreshParseTree(rootTrace);
  }

  function shouldNodeBeLabeled(traceNode, parent) {
    var expr = traceNode.expr;

    // Don't label Seq and Alt nodes.
    if (expr instanceof ohm.pexprs.Seq || expr instanceof ohm.pexprs.Alt) {
      return false;
    }

    // Hide successful nodes that have no bindings.
    if (traceNode.succeeded && traceNode.bindings.length === 0) {
      return false;
    }

    return true;
  }

  function isAlt(expr) {
    return expr instanceof ohm.pexprs.Alt;
  }

  function isSyntactic(expr) {
    if (expr instanceof ohm.pexprs.Apply) {
      return expr.isSyntactic();
    }
    if (expr instanceof ohm.pexprs.Iter ||
        expr instanceof ohm.pexprs.Lookahead ||
        expr instanceof ohm.pexprs.Not) {
      return isSyntactic(expr.expr);
    }
    if (expr instanceof ohm.pexprs.Seq) {
      return expr.factors.some(isSyntactic);
    }
    return expr instanceof ohm.pexprs.Param;
  }

  // Return true if the trace element `el` should be collapsed by default.
  function shouldTraceElementBeCollapsed(traceNode, context) {
    // Don't collapse unlabeled nodes (they can't be expanded), nodes with a collapsed ancestor,
    // or leaf nodes.
    if (context.collapsed || isLeaf(traceNode)) {
      return false;
    }

    // Collapse uppermost failure nodes.
    if (!traceNode.succeeded) {
      return true;
    }

    return context.syntactic && !isSyntactic(traceNode);
  }

  /*
    When showing failures, the nodes representing the branches (choices) of an Alt node are
    stacked vertically. E.g., for a rule `width = pctWidth | pxWidth` where `pctWidth` fails,
    the nodes are layed out like this:

        width
        pctWidth
        pxWidth

    Since this could be confused with `pctWidth` being the parent node of `pxWidth`, we need
    to distinguish choice nodes visually when showing failures. This function returns true if
    `traceNode` is an Alt node whose children should be visually distinguished.
  */
  function hasVisibleChoice(traceNode) {
    if (isAlt(traceNode.expr) && ohmEditor.options.showFailures) {
      // If there's any failed child, we need to show multiple children.
      return traceNode.children.some(function(c) {
        return !c.succeeded;
      });
    }
    return false;
  }

  // Return true if `traceNode` should be treated as a leaf node in the parse tree.
  function isLeaf(traceNode) {
    var pexpr = traceNode.expr;
    if (isPrimitive(pexpr)) {
      return true;
    }
    if (pexpr instanceof ohm.pexprs.Apply) {
      // If the rule body has no source, treat its implementation as opaque.
      var body = ohmEditor.grammar.rules[pexpr.ruleName].body;
      if (!body.source) {
        return true;
      }
    }
    if (isLRBaseCase(traceNode)) {
      return true;
    }
    return traceNode.children.length === 0;
  }

  function isPrimitive(expr) {
    return expr instanceof ohm.pexprs.Terminal ||
           expr instanceof ohm.pexprs.Range ||
           expr instanceof ohm.pexprs.UnicodeChar;
  }

  function isLRBaseCase(traceNode) {
    // If the children are exactly `[undefined]`, it's the base case for left recursion.
    // TODO: Figure out a better way to handle this when generating traces.
    return traceNode.children.length === 1 && traceNode.children[0] == null;
  }

  function hasVisibleLeftRecursion(traceNode) {
    return ohmEditor.options.showFailures && traceNode.terminatingLREntry != null;
  }

  function couldZoom(currentRootTrace, traceNode) {
    return currentRootTrace !== traceNode &&
           traceNode.succeeded &&
           !isLeaf(traceNode);
  }

  Vue.component('trace-label', {
    props: {
      traceNode: {type: Object, required: true},
    },
    computed: {
      extraInfo: function() {
        if (isLRBaseCase(this.traceNode)) {
          return '[LR]';
        }
      },
      inlineRuleNameParts: function() {
        var ruleName = this.traceNode.expr.ruleName;
        if (ruleName) {
          return ruleName.split('_');
        }
      },
      labelData: function() {
        if (this.traceNode.terminatesLR) {
          return {text: '[Grow LR]'};
        }
        if (this.inlineRuleNameParts) {
          return {
            text: this.inlineRuleNameParts[0],
            caseName: this.inlineRuleNameParts[1]
          };
        }
        var fullText = this.traceNode.displayString;

        // Truncate the label if it is too long, and show the full label in the tooltip.
        if (fullText.length > 20 && fullText.indexOf(' ') >= 0) {
          return {
            text: fullText.slice(0, 20) + UnicodeChars.HORIZONTAL_ELLIPSIS,
            tooltip: fullText
          };
        }
        return {text: fullText};
      },
      minWidth: function() {
        return measureInputText(this.traceNode.source.contents) + 'px';
      }
    },
    methods: {
      emitHover: function() {
        this.$emit('hover');
      },
      emitUnhover: function() {
        this.$emit('unhover');
      },
      onClick: function(e) {
        var isPlatformMac = /Mac/.test(navigator.platform);
        var modifierKey = isPlatformMac ? e.metaKey : e.ctrlKey;

        if (e.altKey && !(e.shiftKey || e.metaKey)) {
          this.$emit('click', 'alt');
        } else if (modifierKey && !(e.altKey || e.shiftKey)) {
          this.$emit('click', 'cmd');
        } else {
          this.$emit('click');
        }
        e.preventDefault();
      },
      onContextMenu: function(e) {
        this.$emit('showContextMenu', {
          x: e.clientX,
          y: e.clientY - 6,
          traceNode: this.traceNode
        });
        e.stopPropagation();
        e.preventDefault();
      }
    },
    template: [
      '<div class="label" :title="labelData.tooltip" :style="{minWidth: minWidth}"',
          ' @mouseover="emitHover" @mouseout="emitUnhover" @click="onClick($event)"',
          ' @contextmenu="onContextMenu($event)">',
        '{{ labelData.text }}',
        '<span v-if="labelData.caseName" class="caseName">{{ labelData.caseName }}</span>',
        '<span v-if="extraInfo" class="info">{{ extraInfo }}</span>',
      '</div>',
    ].join('')
  });

  var TraceElement = Vue.component('trace-element', {
    props: {
      traceNode: {type: Object, required: true},
      classes: {type: Object, default: Object},
      isInVBox: {type: Boolean},
      vbox: {type: Boolean}
    },
    computed: {
      classObj: function() {
        var obj = {
          disclosure: this.classes.labeled && this.isInVBox,
        };
        var ctorName = this.traceNode.ctorName;
        if (ctorName) {
          obj[ctorName.toLowerCase()] = true;
        }
        Object.assign(obj, this.classes);
        return obj;
      }
    },
    mounted: function() {
      this.$el._traceNode = this.traceNode;
    },
    updated: function() {
      this.$el._traceNode = this.traceNode;
    },
    methods: {
      onHover: function() {
        var grammarEditor = ohmEditor.ui.grammarEditor;
        var inputEditor = ohmEditor.ui.inputEditor;

        var source = this.traceNode.source;
        var pexpr = this.traceNode.expr;

        updateExpandedInput();

        // TODO: Can `source` ever be undefine/null here?
        if (source) {
          inputMark = cmUtil.markInterval(inputEditor, source, 'highlight', false);
          inputEditor.getWrapperElement().classList.add('highlighting');
        }
        if (pexpr.source) {
          grammarMark = cmUtil.markInterval(grammarEditor, pexpr.source, 'active-appl', false);
          grammarEditor.getWrapperElement().classList.add('highlighting');
          cmUtil.scrollToInterval(grammarEditor, pexpr.source);
        }
        var ruleName = pexpr.ruleName;
        if (ruleName) {
          ohmEditor.emit('peek:ruleDefinition', ruleName);
        }
      },
      onUnhover: function() {
        updateExpandedInput();
        ohmEditor.emit('unpeek:ruleDefinition');
      },
      onClick: function(modifier) {
        if (modifier === 'alt') {
          console.log(this.traceNode);  // eslint-disable-line no-console
        } else if (modifier === 'cmd') {
          // cmd/ctrl + click to open or close semantic editor
          ohmEditor.parseTree.emit('cmdOrCtrlClick:traceElement', this.$el);
        } else if (!isLeaf(this.traceNode)) {
          this.toggleCollapsed();
        }
      },
      onShowContextMenu: function(pos) {
        this.$emit('showContextMenu', pos);
      },
      toggleCollapsed: function() {
        // Caution: direct DOM manipulation here!
        // TODO: Consider using Vue.js <transition> wrapper element.
        var children = this.$refs.children;
        setTraceElementCollapsed(this.$el, !children.hidden);
      }
    },
    template: [
      '<div class="pexpr" :class="classObj">',
      '  <div v-if="classes.labeled" class="self">',
      '    <trace-label :traceNode="traceNode"',
      '                 @hover="onHover" @unhover="onUnhover" @click="onClick"',
      '                 @showContextMenu="onShowContextMenu" />',
      '  </div>',
      '  <div v-if="!classes.leaf" ref="children"',
      '       class="children" :class="{vbox: vbox}"',
      '       :hidden="classes.collapsed">',
      '    <slot />',
      '  </div>',
      '</div>'
    ].join(''),
    /*
    render: function(createElement) {
//      var traceNode = this.traceNode;
//      var pexpr = traceNode.expr;
//      wrapper._traceNode = traceNode;
//      wrapper.id = getFreshNodeId();

      label.addEventListener('contextmenu', function(e) {
        handleContextMenu(e, traceNode);
      });

      return wrapper;
    }
      */
  });

  // To make it easier to navigate around the parse tree, handle mousewheel events
  // and translate vertical overscroll into horizontal movement. I.e., when scrolled all
  // the way down, further downwards scrolling instead moves to the right -- and similarly
  // with up and left.
  parseResultsDiv.onwheel = function(e) {
    var el = e.currentTarget;
    var overscroll;
    var scrollingDown = e.deltaY > 0;

    if (scrollingDown) {
      var scrollBottom = el.scrollHeight - el.clientHeight - el.scrollTop;
      overscroll = e.deltaY - scrollBottom;
      if (overscroll > 0) {
        this.scrollLeft += overscroll;
      }
    } else {
      overscroll = el.scrollTop + e.deltaY;
      if (overscroll < 0) {
        this.scrollLeft += overscroll;
      }
    }
  };
  parseResultsDiv.onscroll = function(e) {
    updateExpandedInput();
  };
  window.addEventListener('resize', function(e) {
    updateExpandedInput();
  });

  // Intialize the zoom out button.
  var zoomOutButton = $('#zoomOutButton');
  zoomOutButton.textContent = UnicodeChars.ANTICLOCKWISE_OPEN_CIRCLE_ARROW;
  zoomOutButton.onclick = function(e) {
    clearZoomState();
  };
  zoomOutButton.onmouseover = function(e) {
    if (zoomState.zoomTrace) {
      updateZoomState({previewOnly: true});
    }
  };
  zoomOutButton.onmouseout = function(e) {
    if (zoomState.zoomTrace) {
      updateZoomState({previewOnly: false});
    }
  };

  var ParseTree = Vue.component('parse-tree', {
    props: {
      trace: {required: true}
    },
    methods: {
      showContextMenu: function(data) {
        var currentRootTrace = zoomState.zoomTrace || this.trace;
        var zoomEnabled = couldZoom(currentRootTrace, data.traceNode);

        var menuDiv = $('#parseTreeMenu');
        menuDiv.style.left = data.x + 'px';
        menuDiv.style.top = data.y + 'px';
        menuDiv.hidden = false;

        domUtil.addMenuItem('parseTreeMenu', 'getInfoItem', 'Get Info', false);
        domUtil.addMenuItem('parseTreeMenu', 'zoomItem', 'Zoom to Node', zoomEnabled, function() {
          updateZoomState({zoomTrace: traceNode});
          clearMarks();
        });
  //      ohmEditor.parseTree.emit('contextMenu', this.$el, this.traceNode);
      }
    },
    render: function(createElement) {
      var rootContainer = createElement('div', []);
      if (!this.trace) {
        return rootContainer;
      }

      var renderedTrace = this.trace;
      if (zoomState.zoomTrace && !zoomState.previewOnly) {
        renderedTrace = zoomState.zoomTrace;
      }
      zoomOutButton.hidden = zoomState.zoomTrace == null;

      var rootElement = createElement(TraceElement, {
        props: {
          traceNode: renderedTrace
        }
      });
      rootContainer.children.push(rootElement);

      var contextStack = [{
        parent: rootElement,
        collapsed: false,
        syntactic: false,
        vbox: false
      }];

      var eventHandlers = {showContextMenu: this.showContextMenu};
      var currentLR = {};

      ohmEditor.parseTree.emit('render:parseTree', renderedTrace);
      var renderActions = {
        enter: function handleEnter(node, parent, depth) {
          // Don't show or recurse into nodes that didn't succeed, unless "Show failures" is enabled.
          if ((!node.succeeded && !ohmEditor.options.showFailures) ||
              (node.isImplicitSpaces && !ohmEditor.options.showSpaces)) {
            return node.SKIP;
          }
          // Don't bother showing whitespace nodes that didn't consume anything.
          var isWhitespace = node.expr.ruleName === 'spaces';
          if (isWhitespace && node.source.contents.length === 0) {
            return node.SKIP;
          }

          var context = contextStack[contextStack.length - 1];
          var isLabeled = shouldNodeBeLabeled(node, parent);
          var collapsed = isLabeled && shouldTraceElementBeCollapsed(node, context);

          var vbox = hasVisibleChoice(node) ||
              hasVisibleLeftRecursion(node) ||
              (isAlt(node.expr) && context.vbox);

          var isLeafNode = isLeaf(node);
          if (node.isMemoized) {
            var memoKey = node.expr.toMemoKey();
            var stack = currentLR[memoKey];
            if (stack && stack[stack.length - 1] === node.pos) {
              isLeafNode = true;
            }
          }

          var traceElement = createElement(TraceElement, {
            props: {
              traceNode: node,
              classes: {
                collapsed: collapsed,
                failed: !node.succeeded,
                labeled: isLabeled,
                leaf: isLeafNode,
                zoomBorder: zoomState.zoomTrace === node && zoomState.previewOnly
              },
              isInVBox: context.vbox,
              vbox: vbox
            },
            on: eventHandlers
          });
          addChildToVNode(context.parent, traceElement);

          if (collapsed) {
  //          ohmEditor.parseTree.emit((collapse ? 'collapse' : 'expand') + ':traceElement', el);
          }

  //        ohmEditor.parseTree.emit('create:traceElement', el, node);

          if (isLeafNode) {
            return node.SKIP;
          }
          contextStack.push({
            parent: traceElement,
            collapsed: collapsed,
            syntactic: isLabeled ? isSyntactic(node.expr) : context.syntactic,
            vbox: vbox
          });
        },
        exit: function(node, parent, depth) {
          // If necessary, render the "Grow LR" trace as a pseudo-child, after the real child.
          // To avoid exponential growth of the tree, when we encounter a memoized entry that
          // is a copy of the head of left recursion, treat it as a leaf.
          if (hasVisibleLeftRecursion(node)) {
            var memoKey = node.expr.toMemoKey();
            var stack = currentLR[memoKey] || [];
            currentLR[memoKey] = stack;
            stack.push(node.pos);
            node.terminatingLREntry.walk(renderActions);
            stack.pop();
          }
          var context = contextStack.pop();
          var el = context.wrapper;
  //        ohmEditor.parseTree.emit('exit:traceElement', el, node);
        }
      };
      renderedTrace.walk(renderActions);
      return rootContainer;
    }
  });

  function updateExpandedInput(optAnimatingEl, isCollapsing, t) {
    var canvasEl = $('#expandedInput');
    var sizer = $('#expandedInputWrapper > #sizer');
    var pixelRatio = getPixelRatio();
    canvasEl.width = sizer.offsetWidth * pixelRatio;
    canvasEl.height = sizer.offsetHeight * pixelRatio;
    canvasEl.style.width = sizer.offsetWidth + 'px';
    canvasEl.style.height = sizer.offsetHeight + 'px';

    // If a parse tree node is currently being hovered, highlight it. If not, highlight
    // the node that has .zoomBorder, if one exists.
    var hovered = $('.pexpr > .self:hover');
    var highlightEl = hovered ? hovered.parentNode : $('.zoomBorder');

    // If there is an animating element, crossfade its input with the input of its
    // descendents -- fade in when collapsing, fade out when expanding.
    var animatingElAlpha = 0;
    if (optAnimatingEl) {
      animatingElAlpha = isCollapsing ? t : 1 - t;
    }

    var root = $('.pexpr');
    var firstFailedEl = domUtil.$('#parseResults > .pexpr > .children > .pexpr.failed');

    (function renderInput(el, isAncestorAnimating) {
      var rect = el.getBoundingClientRect();

      // Skip anything that falls outside the viewport, and any failed nodes apart
      // from the first top-level failure.
      if (!isRectInViewport(rect) ||
          (el.classList.contains('failed') && el !== firstFailedEl)) {
        return;
      }

      if (el === highlightEl) {
        renderHighlight(el);
      }

      if (el.classList.contains('leaf') || el.classList.contains('collapsed')) {
        if (el === firstFailedEl) {
          renderFailedInputText(el, rect);
        } else {
          var alpha = isAncestorAnimating ? 1 - animatingElAlpha : 1;
          renderInputText(getConsumedInput(el), rect, alpha);
        }
      } else {
        // Is `el` currently animating?
        var isAnimating = el === optAnimatingEl;

        // Render the input of the animating element, even though it's not a leaf.
        if (isAnimating) {
          renderInputText(getConsumedInput(el), rect, animatingElAlpha);
        }

        // Ask the subtrees to render.
        var children = el.lastChild.childNodes;
        ArrayProto.forEach.call(children, function(childEl) {
          renderInput(childEl, isAnimating || isAncestorAnimating);
        });
      }
    })(root, false);
  }

  function renderFailedInputText(el, rect) {
    var text = el._traceNode.inputStream.sourceSlice(el._traceNode.pos);
    var renderRect = {
      bottom: rect.bottom,
      left: rect.left,
      right: rect.left + measureInputText(text),
      top: rect.top
    };
    renderInputText(text, renderRect, 0.5);
  }

  function getConsumedInput(el) {
    if (el._traceNode) {
      return el._traceNode.source.contents;
    }
  }

  // When the user makes a change in either editor, show the bottom overlay to indicate
  // that the parse tree is out of date.
  function showBottomOverlay(changedEditor) {
    $('#bottomSection .overlay').style.width = '100%';
  }
  ohmEditor.addListener('change:inputEditor', showBottomOverlay);
  ohmEditor.addListener('change:grammarEditor', showBottomOverlay);

  ohmEditor.addListener('peek:ruleDefinition', function(ruleName) {
    if (ohmEditor.grammar.rules.hasOwnProperty(ruleName)) {
      var defInterval = ohmEditor.grammar.rules[ruleName].source;
      if (defInterval) {
        var grammarEditor = ohmEditor.ui.grammarEditor;
        defMark = cmUtil.markInterval(grammarEditor, defInterval, 'active-definition', true);
        cmUtil.scrollToInterval(grammarEditor, defInterval);
      }
    }
  });

  ohmEditor.addListener('unpeek:ruleDefinition', clearMarks);

  var parseTree = ohmEditor.parseTree = new CheckedEmitter();
  parseTree.vue = new Vue({
    el: '#parseResults',
    data: {
      // The root trace node from the last time the input was parsed (not affected by zooming).
      rootTrace: null
    },
    template: '<parse-tree :trace="rootTrace" />',
    mounted: function() { updateExpandedInput(); },
    updated: function() { updateExpandedInput(); }
  });

  // Refresh the parse tree after attempting to parse the input.
  ohmEditor.addListener('parse:input', function(matchResult, trace) {
    $('#bottomSection .overlay').style.width = 0;  // Hide the overlay.
    $('#semantics').hidden = !ohmEditor.options.semantics;
    parseTree.vue.rootTrace = Object.freeze(trace);
//    clearZoomState();
  });

/*
  parseTree.refresh = function() {
    clearMarks();
    refreshParseTree(rootTrace);
  };
  */
  parseTree.setTraceElementCollapsed = setTraceElementCollapsed;
  parseTree.registerEvents({
    // Emitted when a new trace element `el` is created for `traceNode`.
    'create:traceElement': ['el', 'traceNode'],

    // Emitted when all of a trace element's subtrees have been created.
    'exit:traceElement': ['el', 'traceNode'],

    // Emitted when a trace element is expanded or collapsed.
    'expand:traceElement': ['el'],
    'collapse:traceElement': ['el'],

    // Emitted when the contextMenu for the trace element of `traceNode` is about to be shown.
    'contextMenu': ['target', 'traceNode'],

    // Emitted before start rendering the parse tree
    'render:parseTree': ['traceNode'],

    // Emitted after cmd/ctrl + 'click' on a label
    'cmdOrCtrlClick:traceElement': ['wrapper']
  });
});
