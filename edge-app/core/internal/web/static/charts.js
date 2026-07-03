// Lightweight, dependency-free canvas time-series charts for the VoltPilot Edge
// dashboard. Crisp on HiDPI (devicePixelRatio aware), handles gaps (null
// values), draws a zero line for signed power, and shows a hover tooltip. No
// CDN, no framework - a single reusable class the edge device serves locally.
(function (global) {
  "use strict";

  var nf = new Intl.NumberFormat("de-DE", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

  function niceStep(range, targetTicks) {
    if (range <= 0) return 1;
    var rough = range / targetTicks;
    var mag = Math.pow(10, Math.floor(Math.log10(rough)));
    var norm = rough / mag;
    var step;
    if (norm < 1.5) step = 1;
    else if (norm < 3) step = 2;
    else if (norm < 7) step = 5;
    else step = 10;
    return step * mag;
  }

  function pad2(n) { return n < 10 ? "0" + n : "" + n; }
  function hhmm(ms) { var d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); }

  // TimeChart draws one or more series sharing an x (time) axis.
  // opts: {series:[{key,label,color,area?}], yFixed?:[min,max], unit, zeroLine?, digits?}
  function TimeChart(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.opts = opts || {};
    this.series = this.opts.series || [];
    this.unit = this.opts.unit || "";
    this.digits = this.opts.digits == null ? 1 : this.opts.digits;
    this.points = [];
    this.xMin = 0;
    this.xMax = 1;
    this.hover = null; // {x,y} in css px
    this._geom = null;

    var self = this;
    canvas.addEventListener("mousemove", function (e) {
      var rect = canvas.getBoundingClientRect();
      self.hover = { x: e.clientX - rect.left, y: e.clientY - rect.top };
      self._draw();
    });
    canvas.addEventListener("mouseleave", function () { self.hover = null; self._draw(); });
    // Touch: tap-drag to inspect.
    canvas.addEventListener("touchmove", function (e) {
      var t = e.touches[0]; if (!t) return;
      var rect = canvas.getBoundingClientRect();
      self.hover = { x: t.clientX - rect.left, y: t.clientY - rect.top };
      self._draw();
    }, { passive: true });
    canvas.addEventListener("touchend", function () { self.hover = null; self._draw(); });

    if (global.ResizeObserver) {
      this._ro = new ResizeObserver(function () { self._draw(); });
      this._ro.observe(canvas);
    } else {
      global.addEventListener("resize", function () { self._draw(); });
    }
  }

  TimeChart.prototype.setData = function (points, xMin, xMax) {
    this.points = points || [];
    this.xMin = xMin;
    this.xMax = xMax;
    this._draw();
  };

  TimeChart.prototype._yExtent = function () {
    if (this.opts.yFixed) return this.opts.yFixed.slice();
    var min = Infinity, max = -Infinity;
    var self = this;
    this.points.forEach(function (p) {
      self.series.forEach(function (s) {
        var v = p[s.key];
        if (v == null || isNaN(v)) return;
        if (v < min) min = v;
        if (v > max) max = v;
      });
    });
    if (min === Infinity) { min = 0; max = 1; }
    if (this.opts.zeroLine) { if (min > 0) min = 0; if (max < 0) max = 0; }
    if (min === max) { max = min + 1; }
    var pad = (max - min) * 0.12;
    min -= pad; max += pad;
    if (this.opts.zeroLine) { if (min > 0) min = 0; if (max < 0) max = 0; }
    return [min, max];
  };

  TimeChart.prototype._draw = function () {
    var css = getComputedStyle(document.documentElement);
    var ink = (css.getPropertyValue("--ink") || "#1A1A1A").trim();
    var muted = (css.getPropertyValue("--muted") || "#6C757D").trim();
    var grid = (css.getPropertyValue("--grid") || "#EAEEF3").trim();
    var surface = (css.getPropertyValue("--surface") || "#FFFFFF").trim();

    var canvas = this.canvas, ctx = this.ctx;
    var dpr = global.devicePixelRatio || 1;
    var W = canvas.clientWidth || 600, H = canvas.clientHeight || 220;
    if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
      canvas.width = Math.round(W * dpr);
      canvas.height = Math.round(H * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);

    var padL = 44, padR = 12, padT = 10, padB = 24;
    var plotW = W - padL - padR, plotH = H - padT - padB;
    if (plotW <= 0 || plotH <= 0) return;

    var yr = this._yExtent();
    var yMin = yr[0], yMax = yr[1];
    var xMin = this.xMin, xMax = this.xMax;
    var self = this;

    function X(t) { return padL + ((t - xMin) / (xMax - xMin)) * plotW; }
    function Y(v) { return padT + (1 - (v - yMin) / (yMax - yMin)) * plotH; }
    this._geom = { padL: padL, padT: padT, plotW: plotW, plotH: plotH, X: X, Y: Y, yMin: yMin, yMax: yMax };

    // Y grid + labels.
    ctx.font = "11px Inter, system-ui, sans-serif";
    ctx.textBaseline = "middle";
    var yStep = niceStep(yMax - yMin, 4);
    var start = Math.ceil(yMin / yStep) * yStep;
    ctx.strokeStyle = grid; ctx.fillStyle = muted; ctx.lineWidth = 1;
    for (var v = start; v <= yMax + 1e-9; v += yStep) {
      var y = Y(v);
      ctx.beginPath(); ctx.moveTo(padL, y + 0.5); ctx.lineTo(W - padR, y + 0.5); ctx.stroke();
      ctx.textAlign = "right";
      var lbl = Math.abs(v) < 1e-9 ? "0" : nf.format(v);
      ctx.fillText(lbl, padL - 8, y);
    }
    // Emphasized zero line for signed charts.
    if (this.opts.zeroLine && yMin < 0 && yMax > 0) {
      ctx.strokeStyle = "#C9D2DE"; ctx.lineWidth = 1.4;
      var yz = Y(0);
      ctx.beginPath(); ctx.moveTo(padL, yz + 0.5); ctx.lineTo(W - padR, yz + 0.5); ctx.stroke();
    }

    // X ticks (time).
    ctx.fillStyle = muted; ctx.textAlign = "center"; ctx.textBaseline = "top";
    var span = xMax - xMin;
    var xTickMs = niceTimeStep(span);
    var t0 = Math.ceil(xMin / xTickMs) * xTickMs;
    for (var t = t0; t <= xMax; t += xTickMs) {
      var x = X(t);
      ctx.strokeStyle = grid; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x + 0.5, padT); ctx.lineTo(x + 0.5, padT + plotH); ctx.stroke();
      ctx.fillStyle = muted;
      ctx.fillText(hhmm(t), x, padT + plotH + 6);
    }

    // Series.
    this.series.forEach(function (s) {
      drawSeries(ctx, self.points, s, X, Y, plotH, padT, surface);
    });

    // Latest value dots.
    this.series.forEach(function (s) {
      for (var i = self.points.length - 1; i >= 0; i--) {
        var v = self.points[i][s.key];
        if (v != null && !isNaN(v)) {
          var x = X(self.points[i].t), y = Y(v);
          ctx.beginPath(); ctx.arc(x, y, 3.2, 0, Math.PI * 2);
          ctx.fillStyle = s.color; ctx.fill();
          ctx.lineWidth = 2; ctx.strokeStyle = surface; ctx.stroke();
          break;
        }
      }
    });

    if (this.hover) this._drawHover(ink, muted, surface, grid);
  };

  function drawSeries(ctx, points, s, X, Y, plotH, padT, surface) {
    // Area fill (optional): from the line down to the plot floor.
    if (s.area) {
      ctx.beginPath();
      var started = false, lastX = null;
      for (var i = 0; i < points.length; i++) {
        var v = points[i][s.key];
        if (v == null || isNaN(v)) { continue; }
        var x = X(points[i].t), y = Y(v);
        if (!started) { ctx.moveTo(x, y); started = true; } else { ctx.lineTo(x, y); }
        lastX = x;
      }
      if (started) {
        ctx.lineTo(lastX, padT + plotH);
        // back to first x at floor
        for (var j = 0; j < points.length; j++) {
          var vv = points[j][s.key];
          if (vv != null && !isNaN(vv)) { ctx.lineTo(X(points[j].t), padT + plotH); break; }
        }
        ctx.closePath();
        var g = ctx.createLinearGradient(0, padT, 0, padT + plotH);
        g.addColorStop(0, hexA(s.color, 0.22));
        g.addColorStop(1, hexA(s.color, 0.02));
        ctx.fillStyle = g; ctx.fill();
      }
    }
    // Line (skips gaps).
    ctx.strokeStyle = s.color; ctx.lineWidth = s.width || 2;
    ctx.lineJoin = "round"; ctx.lineCap = "round";
    ctx.beginPath();
    var pen = false;
    for (var k = 0; k < points.length; k++) {
      var val = points[k][s.key];
      if (val == null || isNaN(val)) { pen = false; continue; }
      var px = X(points[k].t), py = Y(val);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else { ctx.lineTo(px, py); }
    }
    ctx.stroke();
  }

  TimeChart.prototype._drawHover = function (ink, muted, surface, grid) {
    var g = this._geom; if (!g || !this.points.length) return;
    var ctx = this.ctx;
    // Nearest point by x.
    var tx = this.xMin + ((this.hover.x - g.padL) / g.plotW) * (this.xMax - this.xMin);
    var best = null, bestD = Infinity;
    for (var i = 0; i < this.points.length; i++) {
      var d = Math.abs(this.points[i].t - tx);
      if (d < bestD) { bestD = d; best = this.points[i]; }
    }
    if (!best) return;
    var hx = g.X(best.t);
    if (hx < g.padL - 1 || hx > g.padL + g.plotW + 1) return;

    // Crosshair.
    ctx.strokeStyle = "#B9C4D2"; ctx.lineWidth = 1; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(hx + 0.5, g.padT); ctx.lineTo(hx + 0.5, g.padT + g.plotH); ctx.stroke();
    ctx.setLineDash([]);

    // Tooltip box.
    var self = this;
    var rows = [];
    this.series.forEach(function (s) {
      var v = best[s.key];
      if (v == null || isNaN(v)) return;
      rows.push({ color: s.color, label: s.label, text: nf.format(v) + " " + self.unit });
    });
    if (!rows.length) return;
    ctx.font = "11px Inter, system-ui, sans-serif";
    var timeStr = new Date(best.t).toLocaleTimeString("de-DE", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    var lines = [timeStr].concat(rows.map(function (r) { return r.label + "  " + r.text; }));
    var tw = 0;
    lines.forEach(function (l) { tw = Math.max(tw, ctx.measureText(l).width); });
    var boxW = tw + 34, rowH = 16, boxH = 12 + lines.length * rowH;
    var bx = hx + 12, by = g.padT + 6;
    if (bx + boxW > g.padL + g.plotW) bx = hx - boxW - 12;
    if (bx < g.padL) bx = g.padL + 2;

    roundRect(ctx, bx, by, boxW, boxH, 8);
    ctx.fillStyle = "rgba(23,32,46,0.92)"; ctx.fill();
    ctx.textBaseline = "middle"; ctx.textAlign = "left";
    ctx.fillStyle = "#E7ECF3"; ctx.font = "600 11px Inter, system-ui, sans-serif";
    ctx.fillText(lines[0], bx + 12, by + 6 + rowH / 2);
    ctx.font = "11px Inter, system-ui, sans-serif";
    for (var r = 0; r < rows.length; r++) {
      var yy = by + 6 + rowH * (r + 1) + rowH / 2;
      ctx.fillStyle = rows[r].color;
      ctx.beginPath(); ctx.arc(bx + 15, yy, 4, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = "#E7ECF3";
      ctx.fillText(rows[r].label, bx + 24, yy);
      ctx.textAlign = "right";
      ctx.fillText(rows[r].text, bx + boxW - 12, yy);
      ctx.textAlign = "left";
    }
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function niceTimeStep(span) {
    var steps = [
      15e3, 30e3, 60e3, 2 * 60e3, 5 * 60e3, 10 * 60e3, 15 * 60e3,
      30 * 60e3, 60 * 60e3, 2 * 3600e3, 3 * 3600e3, 6 * 3600e3
    ];
    for (var i = 0; i < steps.length; i++) {
      if (span / steps[i] <= 7) return steps[i];
    }
    return steps[steps.length - 1];
  }

  // hexA: apply alpha to a #RRGGBB color.
  function hexA(hex, a) {
    hex = hex.replace("#", "");
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    var r = parseInt(hex.substr(0, 2), 16), g = parseInt(hex.substr(2, 2), 16), b = parseInt(hex.substr(4, 2), 16);
    return "rgba(" + r + "," + g + "," + b + "," + a + ")";
  }

  global.TimeChart = TimeChart;
})(window);
