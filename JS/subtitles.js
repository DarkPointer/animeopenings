// A full list of supported features can be found here: https://github.com/AniDevTwitter/animeopenings/wiki/Subtitle-Features

/* List of Methods
Name				Arguments				Description
add					video[,filepath[,show]]	Adds subtitles to the given <video> element. Can also set the subtitle file to use and start showing it.
remove				video					Removes subtitles from the given <video> element.
show				video					Makes the subtitles associated with the given <video> element visible.
hide				video					Hides the subtitles associated with the given <video> element.
visible				video					Whether or not the subtitles associated with the given <video> element are currently visible.
setSubtitleFile		video,filepath			Sets/Changes the subtitle file to use for the given <video> element.
setBorderStyle		video,style				Sets the Border Style of the lines in the subtitle file used by the given <video> element.
											0	Use the styles specified in the subtitle file.
											1	Use Border Style 1 (text has an outline)
											3	Use Border Style 3 (text has a background)
reload				video					Reloads the subtitle file used by the given <video> element.
*/

let SubtitleManager = (function() {
	"use strict";

	// from https://github.com/Yay295/fitCurves
	function fitCurve(points) {
		var add = (A,B) => [A[0]+B[0],A[1]+B[1]];
		var subtract = (A,B) => [A[0]-B[0],A[1]-B[1]];
		var multiply = (A,B) => [A[0]*B,A[1]*B];
		var divide = (A,B) => [A[0]/B,A[1]/B];
		var dot = (A,B) => A[0]*B[0]+A[1]*B[1];
		var norm = A => Math.sqrt((A[0]*A[0])+(A[1]*A[1]));
		var normalize = v => divide(v,norm(v));

		function bezier(ctrlPoly,t) {
			let tx = 1 - t;
			return	add(add(multiply(ctrlPoly[0], tx * tx * tx), multiply(ctrlPoly[1], 3 * tx * tx * t)), add(multiply(ctrlPoly[2], 3 * tx * t * t), multiply(ctrlPoly[3], t * t * t)));
		}

		points = points.filter((point,i) => (i === 0 || !(point[0] === points[i-1][0] && point[1] === points[i-1][1])));
		var len = points.length;
		if (len < 2) return [];

		var leftTangent = normalize(subtract(points[1],points[0]));
		var rightTangent = normalize(subtract(points[len-2],points[len-1]));
		if (len === 2) {
			var dist = norm(subtract(points[0], points[1])) / 3;
			return [points[0], add(points[0], multiply(leftTangent, dist)), add(points[1], multiply(rightTangent, dist)), points[1]];
		}

		var u = [0];
		for (let i = 1; i < len; ++i)
			u.push(u[i-1] + norm(subtract(points[i],points[i-1])));
		for (let i = 0; i < len; ++i)
			u[i] /= u[len-1];

		var bezCurve = [points[0], points[0], points[len-1], points[len-1]];
		var C = [0,0,0,0];
		var X = [0,0];

		for (let i = 0; i < len; ++i) {
			var ui = u[i];
			var ux = 1 - ui
			var A = multiply(leftTangent, 3 * ux * ux * ui);
			var B = multiply(rightTangent, 3 * ux * ui * ui);

			C[0] += dot(A,A);
			C[1] += dot(A,B);
			C[2] += dot(A,B);
			C[3] += dot(B,B);

			var tmp = subtract(points[i],bezier(bezCurve,ui));
			X[0] += dot(A,tmp);
			X[1] += dot(B,tmp);
		}

		var det_C0_C1 = (C[0] * C[3]) - (C[2] * C[1]);
		var det_C0_X  = (C[0] * X[1]) - (C[2] * X[0]);
		var det_X_C1  = (X[0] * C[3]) - (X[1] * C[1]);
		var alpha_l = det_C0_C1 === 0 ? 0 : det_X_C1 / det_C0_C1;
		var alpha_r = det_C0_C1 === 0 ? 0 : det_C0_X / det_C0_C1;
		var segLength = norm(subtract(points[0], points[len-1]));
		var epsilon = 1.0e-6 * segLength;

		if (alpha_l < epsilon || alpha_r < epsilon)
			alpha_l = alpha_r = segLength / 3;
		bezCurve[1] = add(bezCurve[0], multiply(leftTangent, alpha_l));
		bezCurve[2] = add(bezCurve[3], multiply(rightTangent, alpha_r));

		return bezCurve;
	}

	function Renderer(SC,video) {
		// SC == Subtitle Container
		// video == <video> element

		var counter = 1;
		var fontsizes = {};
		var lastTime = -1;
		var renderer = this;
		var TimeOffset, PlaybackSpeed, ScaledBorderAndShadow;
		var assdata, initRequest, rendererBorderStyle, resizeRequest, splitLines, styleCSS, subFile, subtitles;

		var STATES = Object.freeze({UNINITIALIZED: 1, INITIALIZING: 2, CANCELING_INIT: 3, INITIALIZED: 4});
		var state = STATES.UNINITIALIZED;
		var paused = true;

		// Handles subtitle line overrides.
		// Must be `call`ed from a Subtitle with `this`.
		let map = {
			"b" : function(arg,ret) {
				if (arg && +arg) ret.style["font-weight"] = (arg == "1") ? "bold" : arg;
				else delete ret.style["font-weight"];
			},
			"i" : function(arg,ret) {
				if (arg && +arg) ret.style["font-style"] = "italic";
				else delete ret.style["font-style"];
			},
			"u" : function(arg,ret) {
				if (arg && +arg) {
					if (ret.style["text-decoration"]) ret.style["text-decoration"] = "underline line-through";
					else ret.style["text-decoration"] = "underline";
				} else {
					if (ret.style["text-decoration"].indexOf("line-through")+1) ret.style["text-decoration"] = "line-through";
					else delete ret.style["text-decoration"];
				}
			},
			"s" : function(arg,ret) {
				if (arg && +arg) {
					if (ret.style["text-decoration"]) ret.style["text-decoration"] = "underline line-through";
					else ret.style["text-decoration"] = "line-through";
				} else {
					if (ret.style["text-decoration"].indexOf("underline")+1) ret.style["text-decoration"] = "underline";
					else delete ret.style["text-decoration"];
				}
			},
			"alpha" : function(arg) {
				if (!arg) {
					var pStyle = renderer.style[this.style.Name];
					this.style.c1a = pStyle.c1a;
					this.style.c2a = pStyle.c2a;
					this.style.c3a = pStyle.c3a;
					this.style.c4a = pStyle.c4a;
				} else {
					arg = arg.slice(2,-1); // remove 'H' and '&'s
					var a = 1 - (parseInt(arg,16) / 255);
					this.style.c1a = a; // primary fill
					this.style.c2a = a; // secondary fill (for karaoke)
					this.style.c3a = a; // border
					this.style.c4a = a; // shadow
				}
			},
			"1a" : function(arg) {
				this.style.c1a = 1 - (parseInt(arg.slice(2,-1),16) / 255);
			},
			"2a" : function(arg) {
				this.style.c2a = 1 - (parseInt(arg.slice(2,-1),16) / 255);
			},
			"3a" : function(arg) {
				this.style.c3a = 1 - (parseInt(arg.slice(2,-1),16) / 255);
			},
			"4a" : function(arg) {
				this.style.c4a = 1 - (parseInt(arg.slice(2,-1),16) / 255);
			},
			"a" : function(arg) {
				if (typeof(this.style.Alignment) == "string") {
					if (arg == 0) arg = parseInt(renderer.style[this.style.Name].Alignment,10);
					else {
						arg = parseInt(arg,10);
						switch (arg) {
							case 5: arg = 7; break;
							case 6: arg = 8; break;
							case 7: arg = 9; break;
							case 9: arg = 4; break;
							case 10: arg = 5; break;
							case 11: arg = 6;
						}
					}
					this.style.Alignment = arg;
					this.reposition = true;
				}
			},
			"an" : function(arg) {
				if (typeof(this.style.Alignment) == "string") {
					if (arg == 0) arg = renderer.style[this.style.Name].Alignment;
					this.style.Alignment = parseInt(arg,10);
					this.reposition = true;
				}
			},
			"be" : function(arg) {
				this.style.Blur = arg;
			},
			"blur" : function(arg) {
				this.style.Blur = arg;
			},
			"bord" : function(arg) {
				this.style.Outline = arg;
			},
			"xbord" : function(arg) {
				// ?
			},
			"ybord" : function(arg) {
				// ?
			},
			"c" : function(arg) {
				map["1c"].call(this,arg);
			},
			"1c" : function(arg) {
				if (arg.substr(8,2) != "&") {
					this.style.c1a = 1 - (parseInt(arg.substr(2,2),16) / 255);
					arg = arg.substr(2);
				}
				this.style.c1r = parseInt(arg.substr(6,2),16);
				this.style.c1g = parseInt(arg.substr(4,2),16);
				this.style.c1b = parseInt(arg.substr(2,2),16);
			},
			"2c" : function(arg) {
				if (arg.substr(8,2) != "&") {
					this.style.c2a = 1 - (parseInt(arg.substr(2,2),16) / 255);
					arg = arg.substr(2);
				}
				this.style.c2r = parseInt(arg.substr(6,2),16);
				this.style.c2g = parseInt(arg.substr(4,2),16);
				this.style.c2b = parseInt(arg.substr(2,2),16);
			},
			"3c" : function(arg) {
				if (arg.substr(8,2) != "&") {
					this.style.c3a = 1 - (parseInt(arg.substr(2,2),16) / 255);
					arg = arg.substr(2);
				}
				this.style.c3r = parseInt(arg.substr(6,2),16);
				this.style.c3g = parseInt(arg.substr(4,2),16);
				this.style.c3b = parseInt(arg.substr(2,2),16);
			},
			"4c" : function(arg) {
				if (arg.substr(8,2) != "&") {
					this.style.c4a = 1 - (parseInt(arg.substr(2,2),16) / 255);
					arg = arg.substr(2);
				}
				this.style.c4r = parseInt(arg.substr(6,2),16);
				this.style.c4g = parseInt(arg.substr(4,2),16);
				this.style.c4b = parseInt(arg.substr(2,2),16);
			},
			"clip(" : function(arg) {
				if (!arg) return;

				arg = arg.slice(0,-1).split(",");
				if (this.clip) SC.getElementById("clip" + this.clip.num).remove();
				var mask = "<mask id='clip" + counter + "' maskUnits='userSpaceOnUse'><path d='";

				if (arg.length == 4)
					mask += "M " + arg[0] + " " + arg[1] + " L " + arg[2] + " " + arg[1] + " " + arg[2] + " " + arg[3] + " " + arg[0] + " " + arg[3];
				else if (arg.length == 2)
					mask += pathASStoSVG(arg[1], arg[0]);
				else
					mask += pathASStoSVG(arg[0], 1);

				SC.getElementsByTagName("defs")[0].innerHTML += mask + "' /></mask>";

				this.clip = {"type" : "mask", "num" : counter++};
			},
			"iclip(" : function(arg) {
				if (!arg) return;

				arg = arg.slice(0,-1).split(",");
				if (this.clip) SC.getElementById("clip" + this.clip.num).remove();
				var clip = "<clipPath id='clip" + counter + "'><path d='";

				if (arg.length == 4)
					clip += "M " + arg[0] + " " + arg[1] + " L " + arg[2] + " " + arg[1] + " " + arg[2] + " " + arg[3] + " " + arg[0] + " " + arg[3];
				else if (arg.length == 2)
					clip += pathASStoSVG(arg[1], arg[0]);
				else
					clip += pathASStoSVG(arg[0], 1);

				SC.getElementsByTagName("defs")[0].innerHTML += clip + "' /></clipPath>";

				this.clip = {"type" : "clip-path", "num" : counter++};
			},
			"fad(" : function(arg) {
				arg = arg.slice(0,-1).split(",");
				var time = this.time.milliseconds;
				this.addFade(255,0,255,0,arg[0],time-arg[1],time);
			},
			"fade(" : function(arg) {
				arg = arg.slice(0,-1).split(",");
				this.addFade(arg[0],arg[1],arg[2],arg[3],arg[4],arg[5],arg[6]);
			},
			"fax" : function(arg) {
				this.transforms["fax"] = "matrix(1,0," + arg + ",1,0,0)";
			},
			"fay" : function(arg) {
				this.transforms["fay"] = "matrix(1," + arg + ",0,1,0,0)";
			},
			"fn" : function(arg,ret) {
				let size = getFontSize(arg,this.style.Fontsize).size;
				this.style.Fontname = arg;
				this.style.Fontsize = size;
				ret.style["font-family"] = arg;
				ret.style["font-size"] = size + "px";
				this.reposition = true;
			},
			"fr" : function(arg) {
				map["frz"].call(this,arg);
			},
			"frx" : function(arg) {
				this.transforms["frx"] = "rotateX(" + arg + "deg)";
			},
			"fry" : function(arg) {
				this.transforms["fry"] = "rotateY(" + arg + "deg)";
			},
			"frz" : function(arg) {
				this.transforms["frz"] = "rotateZ(" + -(this.style.Angle + parseFloat(arg)) + "deg)";
			},
			"fs" : function(arg,ret) {
				var size;

				if (!arg || arg == "0")
					size = getFontSize(this.style.Fontname,renderer.style[this.style.Name].Fontsize).size;
				else if (arg.charAt(0) == "+" || arg.charAt(0) == "-")
					size = this.style.Fontsize * (1 + (parseInt(arg) / 10));
				else size = getFontSize(this.style.Fontname,arg).size;

				this.style.Fontsize = size;
				ret.style["font-size"] = size + "px";
				this.reposition = true;
			},
			"fsc" : function(arg) {
				map["fscx"].call(this,arg,ret);
				map["fscy"].call(this,arg,ret);
			},
			"fscx" : function(arg) {
				if (!arg || arg == "0") arg = renderer.style[this.style.Name].ScaleX;
				this.style.ScaleX = arg;
				this.transforms["fscx"] = "scaleX(" + arg / 100 + ")";
			},
			"fscy" : function(arg) {
				if (!arg || arg == "0") arg = renderer.style[this.style.Name].ScaleY;
				this.style.ScaleY = arg;
				this.transforms["fscy"] = "scaleY(" + arg / 100 + ")";
			},
			"fsp" : function(arg,ret) {
				if (arg == "0") arg = this.style.Spacing;
				ret.style["letter-spacing"] = arg + "px";
			},
			"k" : function(arg,ret) {
				setKaraokeColors.call(this,arg,ret,false);
			},
			"K" : function(arg,ret) {
				map["kf"].call(this,arg,ret);
			},
			"kf" : function(arg,ret) {
				let startTime = this.karaokeTimer;
				let endTime = startTime + arg * 10;

				let startColor = "rgba(" + this.style.c2r + "," + this.style.c2g + "," + this.style.c2b + "," + this.style.c2a + ")";
				let endColor = "rgba(" + this.style.c1r + "," + this.style.c1g + "," + this.style.c1b + "," + this.style.c1a + ")";
				let grad = document.createElementNS("http://www.w3.org/2000/svg","linearGradient");
					grad.innerHTML = "<stop offset='0' stop-color='" + endColor + "'></stop><stop stop-color='" + startColor + "'></stop>";
					grad.id = "gradient" + counter;
				SC.getElementsByTagName("defs")[0].appendChild(grad);

				ret.style.fill = "url(#gradient" + counter + ")";

				if (this.karaokeTransitions) {
					// remove the previous \k or \ko transition
					let last = this.karaokeTransitions[this.karaokeTransitions.length-1];
					ret.classes = ret.classes.filter(str => !str.endsWith(last));
				}

				if (this.kf) {
					// remove the previous \kf transition
					let last = this.kf[this.kf.length-1];
					ret.classes = ret.classes.filter(str => !str.endsWith(last));
					this.kf.push(counter);
				} else this.kf = [counter];
				ret.classes.push("kf"+counter);

				let vars = {"num" : counter};
				this.updates["kf"+counter] = function(_this,t) {
					if (!vars.start) {
						let range = document.createRange();
						vars.node = SC.querySelector(".kf" + vars.num);
						if (!vars.node) {
							delete _this.updates["kf"+vars.num];
							return;
						}
						range.selectNodeContents(vars.node);
						let eSize = range.getBoundingClientRect();
						let pSize = _this.div.getBoundingClientRect();
						vars.start = (eSize.left - pSize.left) / pSize.width;
						vars.frac = eSize.width / pSize.width;
						vars.gradStop = SC.getElementById("gradient" + vars.num).firstChild;
					}

					vars.node.style.fill = "url(#gradient" + vars.num + ")";
					if (t <= startTime) vars.gradStop.setAttribute("offset", vars.start);
					else if (startTime < t && t < endTime) {
						let val = vars.start + vars.frac * (t - startTime) / (endTime - startTime);
						vars.gradStop.setAttribute("offset", val);
					} else vars.gradStop.setAttribute("offset", vars.start + vars.frac);
				};

				++counter;
				this.karaokeTimer = endTime;
			},
			"ko" : function(arg,ret) {
				setKaraokeColors.call(this,arg,ret,true);
			},
			"kt" : function(arg) {
				this.karaokeTimer += arg * 10;
			},
			"_k" : function(arg,ret) {
				let color = this["k"+arg];
				if (color.isko) this.style.c3a = color.o;
				else {
					ret.style.fill = "rgba(" + color.r + "," + color.g + "," + color.b + "," + color.a + ")";
					this.style.c1r = color.r;
					this.style.c1g = color.g;
					this.style.c1b = color.b;
					this.style.c1a = color.a;
				}
			},
			"move(" : function(arg) {
				arg = arg.slice(0,-1).split(",");
				this.addMove(arg[0],arg[1],arg[2],arg[3],arg[4],arg[5]);
			},
			"org(" : function(arg) {
				arg = arg.slice(0,-1).split(",");
				this.tOrg = arg[0] + "px " + arg[1] + "px";
			},
			"p" : function(arg,ret) {
				ret.hasPath = parseFloat(arg);
				if (ret.hasPath) this.pathOffset.y = 0;
			},
			"pbo" : function(arg) {
				this.pathOffset.y = parseInt(arg,10);
			},
			"pos(" : function(arg) {
				arg = arg.slice(0,-1).split(",");
				this.style.position.x = parseFloat(arg[0]);
				this.style.position.y = parseFloat(arg[1]);
				this.reposition = true;
			},
			"q" : function(arg) {
				if (arg) this.WrapStyle = parseInt(arg);
				else delete this.WrapStyle;
			},
			"r" : function(arg,ret) {
				var pos = this.style.position;
				var style = (!arg ? this.style.Name : (renderer.style[arg] ? arg : this.style.Name));
				ret.classes.push("subtitle_" + style.replace(/ /g,"_"));
				this.style = JSON.parse(JSON.stringify(renderer.style[style]));
				this.style.position = pos;
				this.reposition = true;
			},
			"shad" : function(arg) {
				this.style.ShOffX = arg;
				this.style.ShOffY = arg;
			},
			"xshad" : function(arg) {
				this.style.ShOffX = arg;
				if (!this.style.ShOffY) this.style.ShOffY = 0;
			},
			"yshad" : function(arg) {
				if (!this.style.ShOffX) this.style.ShOffX = 0;
				this.style.ShOffY = arg;
			}
		};

		function timeConvert(HMS) {
			var t = HMS.split(":");
			return t[0]*3600 + t[1]*60 + parseFloat(t[2]);
		}
		function pathASStoSVG(path,scale) {
			// This function converts an ASS style path to a SVG style path.

			// scale path
			path = path.replace(/\d+/g, M => scale * parseFloat(M));

			path = path.toLowerCase();
			path = path.replace(/b/g,"C");	// cubic bezier curve to point 3 using point 1 and 2 as the control points
			path = path.replace(/c/g,"Z");	// close b-spline
			path = path.replace(/l/g,"L");	// line-to <x>, <y>
			path = path.replace(/m/g,"M");	// move-to <x>, <y>
			path = path.replace(/n/g,"M");	// move-to <x>, <y> (without closing shape)
			path = path.replace(/p/g,"");	// extend b-spline to <x>, <y>
			path = path.replace(/s/g,"C");	// 3rd degree uniform b-spline to point N, contains at least 3 coordinates
			return path + " Z";				// close path at the end
		}
		function getFontSize(font,size) {
			size = (+size).toFixed(2);

			if (!fontsizes[font]) {
				fontsizes[font] = {};
				if (document.fonts) {
					document.fonts.load("0 " + font).then(() => {
						fontsizes[font] = {};
						write_styles();
						return getFontSize(font,size);
					});
				}
			}

			if (!fontsizes[font][size]) {
				let temp = SC.style.transform;
				SC.style.transform = "scale(1)";

				var sampleText = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
				var smallE = document.createElementNS("http://www.w3.org/2000/svg","text");
					smallE.style.display = "block";
					smallE.style.fontFamily = font;
					smallE.style.fontSize = 100 + "px";
					smallE.style.opacity = 0;
					smallE.innerHTML = sampleText;
				var bigE = document.createElementNS("http://www.w3.org/2000/svg","text");
					bigE.style.display = "block";
					bigE.style.fontFamily = font;
					bigE.style.fontSize = 300 + "px";
					bigE.style.opacity = 0;
					bigE.innerHTML = sampleText;

				SC.appendChild(smallE);
				SC.appendChild(bigE);
				var scale = (200 / (bigE.getBoundingClientRect().height - smallE.getBoundingClientRect().height));
				smallE.remove();
				bigE.remove();

				let scaled = size * (scale >= 1 ? 1 / scale : scale);

				var finalE = document.createElementNS("http://www.w3.org/2000/svg","text");
					finalE.style.display = "block";
					finalE.style.fontFamily = font;
					finalE.style.fontSize = scaled + "px";
					finalE.style.opacity = 0;
					finalE.innerHTML = sampleText;
				SC.appendChild(finalE);
				let height = finalE.getBoundingClientRect().height;
				finalE.remove();

				fontsizes[font][size] = {"size" : scaled, "height" : height};

				SC.style.transform = temp;
			}

			return fontsizes[font][size];
		}
		function setKaraokeColors(arg,ret,isko) { // for \k and \ko
			// color to start at
			this.karaokeColors = {
				"ko" : isko,
				"r" : this.style.c2r,
				"g" : this.style.c2g,
				"b" : this.style.c2b,
				"a" : this.style.c2a
			};

			// color to return to
			this["k"+counter] = {
				"ko" : isko,
				"r" : this.style.c1r,
				"g" : this.style.c1g,
				"b" : this.style.c1b,
				"a" : this.style.c1a,
				"o" : this.style.c3a
			};

			if (this.kf) {
				// remove the previous \kf transition
				let last = this.kf[this.kf.length-1];
				ret.classes = ret.classes.filter(str => !str.endsWith(last));
			}

			if (this.karaokeTransitions) {
				// remove the previous \k or \ko transition
				let last = this.karaokeTransitions[this.karaokeTransitions.length-1];
				ret.classes = ret.classes.filter(str => !str.endsWith(last));
				this.karaokeTransitions.push(counter);
			} else this.karaokeTransitions = [counter];

			this.addTransition(ret, this.karaokeTimer + "," + this.karaokeTimer, "\\_k" + counter, counter);
			this.karaokeTimer += arg * 10;
			++counter;
		}
		this.setBorderStyle = x => (rendererBorderStyle = parseInt(x,10));

		let NewSubtitle = (function() {
			function createPath(line,scale) {
				// Given an ASS "Dialogue:" line, this function finds the first path in the line and converts it
				// to SVG format. It then returns an object containing both versions of the path (ASS and SVG).

				line = line.slice(line.search(/\\p-?\d+/)+3);
				line = line.slice(line.indexOf("}")+1);
				if (line.indexOf("{") >= 0) line = line.slice(0,line.indexOf("{"));

				return {"ass" : line, "svg" : pathASStoSVG(line,scale)};
			}
			function sameColor(start,end) {
				return (start.r == end.r && start.g == end.g && start.b == end.b && start.a == end.a);
			}


			// These functions are `call`ed from other functions.
			function parse_text_line(line) {
				this.karaokeTimer = 0;

				let overrides = line.match(/{.*?}/g) || ["}"];
				let ret = {"style" : {}, "classes" : []};
				this.pathOffset.x = 0; // Horizontal Path Offset
				for (let match of overrides) { // match == "{...}"
					override_to_html.call(this,match,ret);

					if (ret.hasPath) {
						let path = createPath(line,ret.hasPath);
						line = line.replace(path.ass,""); // remove .ass path commands

						let classes = this.div.getAttribute("class");
						if (ret.classes.length) classes += " " + ret.classes.join(" ");

						let styles = "display:block;";
						for (let x in ret.style) styles += x + ":" + ret.style[x] + ";";

						let E = document.createElementNS("http://www.w3.org/2000/svg","path");
							E.setAttribute("d",path.svg);
							E.setAttribute("class",classes);
							E.setAttribute("style",styles);

						if (!this.paths) this.paths = [E];
						else this.paths.push(E);

						let A = this.style.Alignment;
						if (A % 3) { // 1, 2, 4, 5, 7, 8
							SC.appendChild(E);
							let offset = E.getBBox().width;
							E.remove();
							if ((A + 1) % 3 == 0) // 2, 5, 8
								offset /= 2;
							this.pathOffset.x += offset * this.style.ScaleX / 100;
						}
					}

					updateShadows.call(this,ret);

					let retval = "</tspan><tspan style=\"";
					for (let x in ret.style) retval += x + ":" + ret.style[x] + ";";
					if (ret.classes.length) retval += "\" class=\"" + ret.classes.join(" ");
					if (this.pathOffset.x && !ret.hasPath) {
						retval += "\" dx=\"" + this.pathOffset.x;
						this.pathOffset.x = 0;
					}
					retval += "\">";

					line = line.replace(match, retval);
				}
				return line + "</tspan>";
			}
			function override_to_html(match,ret) {
				// Remove {,} tags and first "\", then split on the remaining "\".
				let options = match.slice(match.indexOf("\\")+1,-1).split("\\");

				let transition = 0;
				let transitionString = "";
				let transline = "";
				for (let key in options) {
					let option = options[key].trim();

					if (transition) {
						transline += "\\" + option;
						transition += option.split("(").length - 1;
						transition -= option.split(")").length - 1;
					} else if (option.slice(0,2) == "t(") {
						++transition;
						transitionString = option.slice(2,-1);
						transline = "";
					} else {
						let i = 1 + Math.min(option.length,6);
						while (i --> 0) {
							if (map[option.slice(0,i)]) {
								let val = option.slice(i);
								if (val.charAt(0) == "(" && val.charAt(val.length-1) == ")")
									val = val.slice(1,-1);
								map[option.slice(0,i)].call(this,val,ret);
								break;
							}
						}
						if (!i) ret.classes.push(option);
					}

					if (transline && !transition) {
						this.addTransition(ret,transitionString,transline.slice(0,-1),counter);
						++counter;
					}
				}

				// update colors
				if (!ret.style.fill || (ret.style.fill && (ret.style.fill.slice(0,4) != "url("))) {
					if (this.karaokeColors && !this.karaokeColors.ko)
						ret.style.fill = "rgba(" + this.karaokeColors.r + "," + this.karaokeColors.g + "," + this.karaokeColors.b + "," + this.karaokeColors.a + ")";
					else
						ret.style.fill = "rgba(" + this.style.c1r + "," + this.style.c1g + "," + this.style.c1b + "," + this.style.c1a + ")";
				}
				ret.style.stroke = "rgba(" + this.style.c3r + "," + this.style.c3g + "," + this.style.c3b + "," + (this.karaokeColors && this.karaokeColors.ko ? 0 : this.style.c3a) + ")";
				ret.style["stroke-width"] = this.style.Outline + "px";
				this.karaokeColors = null;
			}

			function updateShadows(ret) {
				let RS = ret.style;
				let TS = this.style;

				let fillColor = RS.fill;
				let borderColor = RS.stroke;
				let shadowColor = "rgba(" + TS.c4r + "," + TS.c4g + "," + TS.c4b + "," + TS.c4a + ")";

				let noBorderBox = ((rendererBorderStyle || TS.BorderStyle) != 3);
				if (noBorderBox) { // Outline and Shadow
					this.box = null;
					this.div.style.filter = "";
					if (TS.Blur) // \be, \blur
						this.div.style.filter += "drop-shadow(0 0 " + TS.Blur + "px " + (TS.Outline ? borderColor : fillColor) + ") ";
					if (TS.ShOffX != 0 || TS.ShOffY != 0) // \shad, \xshad, \yshad
						this.div.style.filter += "drop-shadow(" + TS.ShOffX + "px " + TS.ShOffY + "px 0 " + shadowColor + ")";
				} else { // Border Box
					let TBS = this.box.style;

					TBS.fill = borderColor;
					TBS.stroke = (TS.Outline ? borderColor : fillColor);
					TBS.strokeWidth = RS["stroke-width"];

					// Remove text border from lines that have a border box.
					RS["stroke-width"] = "0px";

					if (TS.Blur) // \be, \blur
						this.div.style.filter = "drop-shadow(0 0 " + TS.Blur + "px " + fillColor + ")";

					if (TS.ShOffX != 0 || TS.ShOffY != 0) // \shad, \xshad, \yshad
						TBS.filter = "drop-shadow(" + TS.ShOffX + "px " + TS.ShOffY + "px 0 " + shadowColor + ")";
					else TBS.filter = "";
				}

				if (this.paths) {
					for (var path of this.paths) {
						path.style.filter = "";
						if (TS.Blur) // \be, \blur
							path.style.filter += "drop-shadow(0 0 " + TS.Blur + "px " + shadowColor + ") ";
						if (TS.ShOffX != 0 || TS.ShOffY != 0) // \shad, \xshad, \yshad
							path.style.filter += "drop-shadow(" + TS.ShOffX + "px " + TS.ShOffY + "px 0 " + shadowColor + ")";
					}
				}
			}
			function updateDivPosition(TS,TD,A,Margin) {
				// This is called if alignment, position, font name, or font size change.

				// `renderer.style[TS.Name].Fontsize`, not `TS.Fontsize`.
				// I don't know why, but things aren't positioned properly otherwise.
				let H = getFontSize(TS.Fontname,renderer.style[TS.Name].Fontsize).height;
				let SA = TD.setAttribute.bind(TD);

				// The 'y' value is for the bottom of the div, not the top,
				// so we have to offset it by the height of the text.

				if (TS.position.x) {
					SA("x",TS.position.x);
					SA("y",TS.position.y);

					if (A > 6) SA("dy",H); // 7, 8, 9
					else if (A < 4) SA("dy",0); // 1, 2, 3
					else SA("dy",H/2); // 4, 5, 6

					if (A%3 == 0) SA("text-anchor","end"); // 3, 6, 9
					else if ((A+1)%3 == 0) SA("text-anchor","middle"); // 2, 5, 8
					else SA("text-anchor","start"); // 1, 4, 7
				} else {
					if (A > 6) { // 7, 8, 9
						SA("dy",H);
						SA("y",Margin.V);
					} else if (A < 4) { // 1, 2, 3
						SA("dy",0);
						SA("y",SC.getAttribute("height")-Margin.V);
					} else { // 4, 5, 6
						SA("dy",H/2);
						SA("y",SC.getAttribute("height")/2);
					}

					if (A%3 == 0) { // 3, 6, 9
						SA("text-anchor","end");
						SA("x",SC.getAttribute("width")-Margin.R);
					} else if ((A+1)%3 == 0) { // 2, 5, 8
						SA("text-anchor","middle");
						SA("x",((Margin.L-Margin.R)/2)+(SC.getAttribute("width")/2));
					} else { // 1, 4, 7
						SA("text-anchor","start");
						SA("x",Margin.L);
					}
				}
			}
			function updatePosition() {
				// Everything is positioned from its top-left corner. This location
				// is also used as the transform origin (if one isn't set). The text is
				// aligned by changing its apparent location, not it's x and y values.

				this.moved = true;

				let TS = this.style;
				let TSSX = TS.ScaleX / 100;
				let TSSY = TS.ScaleY / 100;
				let A = parseInt(TS.Alignment,10);
				let TD = this.div;

				if (TS.Angle && !this.transforms["frz"]) this.transforms["frz"] = "rotateZ(" + (-TS.Angle) + "deg)";
				if (TSSX != 1 && !this.transforms["fscx"])
					this.transforms["fscx"] = "scaleX(" + TSSX + ")";
				if (TSSY != 1 && !this.transforms["fscy"])
					this.transforms["fscy"] = "scaleY(" + TSSY + ")";

				let transforms = "";
				for (let key in this.transforms) transforms += " " + this.transforms[key];

				// Set div anchor and offset.
				if (this.reposition) {
					updateDivPosition(TS,TD,A,this.Margin);
					this.reposition = false;
				}

				// This is the position of the div's anchor point.
				let divX = TD.getAttribute("x");
				let divY = TD.getAttribute("y");

				// This is the actual div position.
				let bbox = TD.getBBox();
				let X = bbox.x;
				let Y = bbox.y;
				let W = bbox.width;
				let H = bbox.height;

				let origin = this.tOrg;
				if (!origin) {
					let ox = X, oy = Y;

					if (A%3 == 0) ox += W; // 3, 6, 9
					else if ((A+1)%3 == 0) ox += W / 2; // 2, 5, 8

					if (A < 7) {
						if (A < 4) oy += H;
						else oy += H / 2;
					}

					origin = ox + "px " + oy + "px";
				}

				TD.style.transform = transforms;
				TD.style.transformOrigin = origin;
				if (this.box) {
					let TB = this.box;
					TB.style.transform = transforms;
					TB.style.transformOrigin = origin;

					let B = parseFloat(TB.style.strokeWidth);
					TB.setAttribute("x", X - B);
					TB.setAttribute("y", Y - B);
					TB.setAttribute("width", W + 2*B);
					TB.setAttribute("height", H + 2*B);
				}
				if (this.paths) {
					let divXf = parseFloat(divX);
					let divYf = parseFloat(divY);
					for (let path of this.paths) {
						let px = divXf, py = divYf;

						if (A != 7) {
							let pBounds = path.getBBox();

							if (A%3 == 0) px -= TSSX * (W + pBounds.width); // 3, 6, 9
							else if ((A+1)%3 == 0) px -= TSSX * (W + pBounds.width) / 2; // 2, 5, 8

							if (A < 7) {
								if (A < 4) py -= TSSY * pBounds.height;
								else py -= TSSY * pBounds.height / 2;
							}
						}

						path.style.transform = "translate(" + px + "px," + py + "px)" + transforms;
					}
				}
				if (this.kf) {
					let tt = "translate(" + divX + "px," + divY + "px)" + transforms + " translate(" + (-divX) + "px," + (-divY) + "px)";
					for (let num of this.kf) SC.getElementById("gradient" + num).setAttribute("gradient-transform", tt);
				}
			};

			function transition(t) {
				// If the line has stopped displaying before the transition starts.
				if (!this.div) return;

				let ret = t.ret;
				let duration = t.duration;
				let options = t.options;
				let accel = t.accel;
				let id = t.id;

				// copy some starting ret style values
				let SRS = {
					"fill": ret.style.fill,
					"stroke": ret.style.stroke,
					"stroke-width": ret.style["stroke-width"]
				};

				// copy starting colors
				let startColors, endColors, updateGradients = this.kf && duration;
				if (updateGradients) {
					startColors = {
						primary: {
							r: this.style.c1r,
							g: this.style.c1g,
							b: this.style.c1b,
							a: this.style.c1a
						},
						secondary: {
							r: this.style.c2r,
							g: this.style.c2g,
							b: this.style.c2b,
							a: this.style.c2a
						},
						border: {
							r: this.style.c3r,
							g: this.style.c3g,
							b: this.style.c3b,
							a: this.style.c3a
						},
						shadow: {
							r: this.style.c4r,
							g: this.style.c4g,
							b: this.style.c4b,
							a: this.style.c4a
						}
					};
				}

				override_to_html.call(this,options+"}",ret);

				// check if the copied ret style values have changed
				let RSChanged = SRS.fill != ret.style.fill || SRS.stroke != ret.style.stroke || SRS["stroke-width"] != ret.style["stroke-width"];

				// copy ending colors
				if (updateGradients) {
					endColors = {
						primary: {
							r: this.style.c1r,
							g: this.style.c1g,
							b: this.style.c1b,
							a: this.style.c1a
						},
						secondary: {
							r: this.style.c2r,
							g: this.style.c2g,
							b: this.style.c2b,
							a: this.style.c2a
						},
						border: {
							r: this.style.c3r,
							g: this.style.c3g,
							b: this.style.c3b,
							a: this.style.c3a
						},
						shadow: {
							r: this.style.c4r,
							g: this.style.c4g,
							b: this.style.c4b,
							a: this.style.c4a
						}
					};
				}


				let divs = SC.getElementsByClassName("transition"+id);
				let trans = "all " + duration + "ms ";

				if (accel == 1) trans += "linear";
				else {
					let CBC = fitCurve([[0,0],[0.25,Math.pow(0.25,accel)],[0.5,Math.pow(0.5,accel)],[0.75,Math.pow(0.75,accel)],[1,1]]);
					// cubic-bezier(x1, y1, x2, y2)
					trans += CBC.length ? "cubic-bezier(" + CBC[1][0] + "," + CBC[1][1] + "," + CBC[2][0] + "," + CBC[2][1] + ")" : "linear";
				}

				this.div.style.transition = trans; // for transitions that can only be applied to the entire line
				for (let div of divs) {
					div.style.transition = trans;
					for (let x in ret.style)
						div.style[x] = ret.style[x];
					div.setAttribute("class", div.getAttribute("class") + " " + ret.classes.join(" "));
				}
				if (this.box) this.box.style.transition = trans;

				// update \kf color gradients
				if (updateGradients) {
					let pColorChanged = !sameColor(startColors.primary, endColors.primary);
					let sColorChanged = !sameColor(startColors.secondary, endColors.secondary);
					if (pColorChanged || sColorChanged) {
						let p1 = startColors.primary, s1 = startColors.secondary;
						let p2 = endColors.primary, s2 = endColors.secondary;
						let before = "<animate attributeName='stop-color' from='rgba(";
						let after = ")' dur='" + duration + "ms' fill='freeze' />";
						let anim1 = before + [p1.r, p1.g, p1.b, p1.a].join() + ")' to='rgba(" + [p2.r, p2.g, p2.b, p2.a].join() + after;
						let anim2 = before + [s1.r, s1.g, s1.b, s1.a].join() + ")' to='rgba(" + [s2.r, s2.g, s2.b, s2.a].join() + after;
						for (let num of this.kf) {
							let stop = SC.getElementById("gradient" + num).children;
							if (pColorChanged) stop[0].innerHTML = anim1;
							if (sColorChanged) stop[1].innerHTML = anim2;
						}
					}
				}

				if (RSChanged) updateShadows.call(this,ret);
				updatePosition.call(this);
			}
			function clearTransitions(id) {
				let divs = SC.getElementsByClassName("transition"+id);
				if (this.div) this.div.style.transition = "";
				for (let div of divs) div.style.transition = "";
				if (this.box) this.box.style.transition = "";
			}


			// The Subtitle 'Class'.
			function Subtitle(data,lineNum) {
				this.data = data;
				this.lineNum = lineNum;

				this.Margin = {"L" : (data.MarginL && parseInt(data.MarginL)) || renderer.style[data.Style].MarginL,
							   "R" : (data.MarginR && parseInt(data.MarginR)) || renderer.style[data.Style].MarginR,
							   "V" : (data.MarginV && parseInt(data.MarginV)) || renderer.style[data.Style].MarginV};

				this.time = {"start" : timeConvert(data.Start), "end" : timeConvert(data.End)};
				this.time.milliseconds = (this.time.end - this.time.start) * 1000;
				this.pathOffset = {x:0,y:0};
				this.visible = false;
			}


			// These functions get the dimensions of the text relative to the window,
			// so make sure to remove the scaling on the SC before using them (and put it back after).
			Subtitle.prototype.width = function() {
				var range = new Range();
				range.selectNodeContents(this.div);
				return range.getBoundingClientRect().width + this.pathOffset.x;
			};
			Subtitle.prototype.height = function() {
				var range = new Range();
				range.selectNodeContents(this.div);
				return range.getBoundingClientRect().height;
			};

			Subtitle.prototype.start = function(time) {
				this.style = JSON.parse(JSON.stringify(renderer.style[this.data.Style])); // deep clone

				this.div = document.createElementNS("http://www.w3.org/2000/svg", "text");
				var TD = this.div;
				TD.setAttribute("class", "subtitle_" + this.data.Style);

				this.box = document.createElementNS("http://www.w3.org/2000/svg", "rect");

				this.transitions = [];
				this.transforms = {};
				this.updates = {};
				this.style.position = {};

				if (this.Margin.L) TD.style["margin-left"] = this.Margin.L + "px";
				if (this.Margin.R) TD.style["margin-right"] = this.Margin.R + "px";
				if (this.Margin.V) {
					TD.style["margin-top"] = this.Margin.V + "px";
					TD.style["margin-bottom"] = this.Margin.V + "px";
				}

				TD.innerHTML = parse_text_line.call(this,this.data.Text);

				this.group = document.createElementNS("http://www.w3.org/2000/svg", "g");
				this.group.setAttribute("id", "line" + this.lineNum);
				this.group.appendChild(TD);

				if (this.box) this.group.insertBefore(this.box,TD);
				if (this.paths) for (var path of this.paths) this.group.insertBefore(path,TD);
				if (this.clip) this.group.setAttribute(this.clip.type, "url(#clip" + this.clip.num + ")");

				SC.getElementById("layer" + this.data.Layer).appendChild(this.group);

				this.reposition = true;
				updatePosition.call(this);

				this.visible = true;
			};
			Subtitle.prototype.update = function(t) {
				let time = t * 1000;
				for (let key in this.updates)
					this.updates[key](this,time);
				if (this.transitions) {
					let todo = this.transitions.filter(t => t.time <= time);
					if (todo) {
						this.transitions = this.transitions.filter(t => t.time > time);
						for (let t of todo) {
							// Add the transition to the task queue.
							setTimeout(() => transition.call(this,t),0);

							// Remove all those transitions so they don't affect anything else.
							// Changing the transition timing doesn't affect currently running
							// transitions, so this is okay to do. We do have to let the animation
							// actually start first though, so we can't do it immediately.
							setTimeout(() => clearTransitions.call(this,t.id),0);
						}
					}
				}
			};
			Subtitle.prototype.cleanup = function() {
				if (this.group) this.group.remove();
				if (this.kf) for (var num of this.kf) SC.getElementById("gradient" + num).remove();
				if (this.clip) SC.getElementById("clip" + this.clip.num).remove();

				this.group = null;
				this.box = null;
				this.div = null;
				this.paths = null;

				this.kf = null;
				this.clip = null;

				this.visible = false;
			};

			Subtitle.prototype.addFade = function(a1,a2,a3,t1,t2,t3,t4) {
				var o1 = 1 - a1/255;
				var o2 = 1 - a2/255;
				var o3 = 1 - a3/255;
				this.div.style.opacity = o1; // Prevent flickering at the start.
				this.updates["fade"] = function(_this,t) {
					if (t <= t1) _this.div.style.opacity = o1;
					else if (t1 < t && t < t2) _this.div.style.opacity = o1 + (o2-o1) * (t-t1) / (t2-t1);
					else if (t2 < t && t < t3) _this.div.style.opacity = o2;
					else if (t3 < t && t < t4) _this.div.style.opacity = o2 + (o3-o2) * (t-t3) / (t4-t3);
					else _this.div.style.opacity = o3;
				};
				if (this.box) {
					this.box.style.opacity = o1; // Prevent flickering at the start.
					this.updates["boxfade"] = function(_this,t) {
						if (!_this.box) delete _this.updates["boxfade"];
						else {
							if (t <= t1) _this.box.style.opacity = o1;
							else if (t1 < t && t < t2) _this.box.style.opacity = o1 + (o2-o1) * (t-t1) / (t2-t1);
							else if (t2 < t && t < t3) _this.box.style.opacity = o2;
							else if (t3 < t && t < t4) _this.box.style.opacity = o2 + (o3-o2) * (t-t3) / (t4-t3);
							else _this.box.style.opacity = o3;
						}
					};
				}
			};
			Subtitle.prototype.addMove = function(x1,y1,x2,y2,t1,t2,accel) {
				if (t1 === undefined) t1 = 0;
				if (t2 === undefined) t2 = this.time.milliseconds;
				if (accel === undefined) accel = 1;
				this.style.position = {"x" : parseFloat(x1), "y" : parseFloat(y1)};
				this.reposition = true;
				this.updates["move"] = function(_this,t) {
					if (t < t1) t = t1;
					if (t > t2) t = t2;
					let calc = Math.pow((t-t1)/(t2-t1),accel);
					let newPos = {"x" : parseFloat(x1) + (x2 - x1) * calc, "y" : parseFloat(y1) + (y2 - y1) * calc};
					if (_this.style.position.x != newPos.x || _this.style.position.y != newPos.y) {
						_this.style.position = newPos;
						_this.reposition = true;
						updatePosition.call(_this);
					}
				};
			};
			Subtitle.prototype.addTransition = function(ret,times,options,trans_n) {
				ret.classes.push("transition" + trans_n);
				times = times.split(",");
				var intime, outtime, accel = 1;

				switch (times.length) {
					case 3:
						accel = parseFloat(times[2]);
					case 2:
						outtime = times[1];
						intime = times[0];
						break;
					case 1:
						if (times[0]) accel = parseFloat(times[0]);
						outtime = this.time.milliseconds;
						intime = 0;
				}

				while (options.indexOf("pos(") >= 0) {
					let pos = options.slice(options.indexOf("pos(")+4,options.indexOf(")")).split(",");
					options = options.replace(/\\pos\((\d|,)*\)/,"");
					this.addMove(this.style.position.x,this.style.position.y,pos[0],pos[1],intime,outtime,accel);
				}

				if (options) {
					this.transitions.push({
						"time" : intime,
						"ret" : JSON.parse(JSON.stringify(ret)), // make a copy of the current values
						"duration" : outtime - intime,
						"options" : options,
						"accel" : accel,
						"id" : trans_n
					});
				}
			};


			return function(data,lineNum) {return new Subtitle(data,lineNum);};
		})();

		function parse_info(assfile,i) {
			var info = {};
			for (; i < assfile.length; ++i) {
				var line = assfile[i] = assfile[i].trim();
				if (line) {
					if (line.charAt(0) == "[") break;
					if (line.charAt(0) == "!" || line.charAt(0) == ";") continue;
					var keyval = line.split(":");
					if (keyval.length != 2) continue;
					info[keyval[0].trim()] = keyval[1].trim();
				}
			}
			return [info,i-1];
		}
		function parse_styles(assfile,i) {
			var styles = {};
			var map = assfile[i].replace("Format:","").split(",").map(x => x.trim());
			for (++i; i < assfile.length; ++i) {
				var line = assfile[i] = assfile[i].trim();
				if (line.charAt(0) == "[") break;
				if (line.search("Style:") != 0) continue;
				var elems = line.replace("Style:","").split(",").map(x => x.trim());
				var new_style = {};
				for (var j = 0; j < elems.length; ++j)
					new_style[map[j]] = elems[j];
				new_style.Name = new_style.Name.replace(/[^_a-zA-Z0-9-]/g,"_");
				styles[new_style.Name] = new_style;
			}
			return [styles,i-1];
		}
		function parse_events(assfile,i) {
			var events = []; events.line = i + 1;
			var map = assfile[i].replace("Format:","").split(",").map(x => x.trim());
			for (++i; i < assfile.length; ++i) {
				var line = assfile[i] = assfile[i].trim();
				if (line.charAt(0) == "[") break;
				if (line.search("Dialogue:") != 0) continue;
				var elems = line.replace("Dialogue:","").trim().split(",");
				var j, new_event = {};
				for (j = 0; map[j] != "Text" && j < map.length; ++j)
					new_event[map[j]] = elems[j];
				new_event.Style = new_event.Style.replace(/[^_a-zA-Z0-9-]/g,"_");
				if (map[j] == "Text") new_event.Text = elems.slice(j).join(",");
				events.push(new_event);
			}
			return [events,i-1];
		}
		function ass2js(asstext) {
			var subtitles = {styles:{}};
			var assfile = asstext.split("\n");
			for (var i = 0; i < assfile.length; ++i) {
				var line = assfile[i] = assfile[i].trim();
				if (line && line.charAt(0) == "[") {
					if (line == "[Script Info]")
						[subtitles.info,i] = parse_info(assfile,i+1);
					else if (line.indexOf("Styles") > -1)
						[subtitles.styles,i] = parse_styles(assfile,i+1);
					else if (line == "[Events]")
						[subtitles.events,i] = parse_events(assfile,i+1);
				}
			}
			return subtitles;
		}

		function style_to_css(style) {
			let ret = "";
			if (style.Fontname) {
				if (style.Fontname.charAt(0) == "@") {
					style.Fontname = style.Fontname.slice(1);
					style.Vertical = true;
				}
			} else style.Fontname = "Arial";
			ret += "font-family: " + style.Fontname + ";\n";

			if (!style.Fontsize) style.Fontsize = 40;
			ret += "font-size: " + getFontSize(style.Fontname,style.Fontsize).size + "px;\n";

			if (+style.Bold) ret += "font-weight: bold;\n";
			if (+style.Italic) ret += "font-style: italic;\n";
			if (+style.Underline || +style.StrikeOut) {
				ret += "text-decoration:";
				if (+style.Underline) ret += " underline";
				if (+style.StrikeOut) ret += " line-through";
				ret += ";\n";
			}

			if (!style.ScaleX) style.ScaleX = 100;
			if (!style.ScaleY) style.ScaleY = 100;

			if (style.Spacing) ret += "letter-spacing: " + style.Spacing + "px;\n";
			else style.Spacing = "0";


			// Remove "&H" or set default.
			style.PrimaryColour = style.PrimaryColour ? style.PrimaryColour.slice(2) : "FFFFFF"; // white
			style.SecondaryColour = style.SecondaryColour ? style.SecondaryColour.slice(2) : "FF0000"; // blue
			style.OutlineColour = style.OutlineColour ? style.OutlineColour.slice(2) : "000000"; // black
			style.BackColour = style.BackColour ? style.BackColour.slice(2) : "000000"; // black

			// Apparently, black can sometimes be listed as just "&H0".
			if (style.PrimaryColour.length == 1) style.PrimaryColour = "000000";
			if (style.SecondaryColour.length == 1) style.SecondaryColour = "000000";
			if (style.OutlineColour.length == 1) style.OutlineColour = "000000";
			if (style.BackColour.length == 1) style.BackColour = "000000";

			if (style.PrimaryColour.length == 8) {
				style.c1a = (255-parseInt(style.PrimaryColour.substr(0,2),16))/255;
				style.PrimaryColour = style.PrimaryColour.slice(2);
			} else style.c1a = 1;
			style.c1r = parseInt(style.PrimaryColour.substr(4,2),16);
			style.c1g = parseInt(style.PrimaryColour.substr(2,2),16);
			style.c1b = parseInt(style.PrimaryColour.substr(0,2),16);

			if (style.SecondaryColour.length == 8) {
				style.c2a = (255-parseInt(style.SecondaryColour.substr(0,2),16))/255;
				style.SecondaryColour = style.SecondaryColour.slice(2);
			} else style.c2a = 1;
			style.c2r = parseInt(style.SecondaryColour.substr(4,2),16);
			style.c2g = parseInt(style.SecondaryColour.substr(2,2),16);
			style.c2b = parseInt(style.SecondaryColour.substr(0,2),16);

			if (style.OutlineColour.length == 8) {
				style.c3a = (255-parseInt(style.OutlineColour.substr(0,2),16))/255;
				style.OutlineColour = style.OutlineColour.slice(2);
			} else style.c3a = 1;
			style.c3r = parseInt(style.OutlineColour.substr(4,2),16);
			style.c3g = parseInt(style.OutlineColour.substr(2,2),16);
			style.c3b = parseInt(style.OutlineColour.substr(0,2),16);

			if (style.BackColour.length == 8) {
				style.c4a = (255-parseInt(style.BackColour.substr(0,2),16))/255;
				style.BackColour = style.BackColour.slice(2);
			} else style.c4a = 1;
			style.c4r = parseInt(style.BackColour.substr(4,2),16);
			style.c4g = parseInt(style.BackColour.substr(2,2),16);
			style.c4b = parseInt(style.BackColour.substr(0,2),16);


			if (!style.Angle) style.Angle = 0;
			else style.Angle = parseFloat(style.Angle);
			if (style.Vertical) {
				style.Angle -= 270; // Why 270?
				ret += "writing-mode: vertical-rl;\n";
			}

			if (!style.BorderStyle) style.BorderStyle = 1;
			if (!style.Outline) style.Outline = 0;

			if (+style.Shadow) {
				if (style.Outline == 0) style.Outline = 1;
				style.ShOffX = style.Shadow;
				style.ShOffY = style.Shadow;
			} else {
				style.ShOffX = 0;
				style.ShOffY = 0;
			}

			ret += "fill: rgba(" + style.c1r + "," + style.c1g + "," + style.c1b + "," + style.c1a + ");\n";
			ret += "stroke: rgba(" + style.c3r + "," + style.c3g + "," + style.c3b + "," + style.c3a + ");\n";
			ret += "stroke-width: " + style.Outline + "px;\n";


			if (!style.Alignment) style.Alignment = "2";
			var N = parseInt(style.Alignment,10);

			ret += "text-align: ";
			if (N%3 == 0) ret += "right"; // 3, 6, 9
			else if ((N+1)%3 == 0) ret += "center"; // 2, 5, 8
			else ret += "left"; // 1, 4, 7
			ret += ";\n";

			ret += "vertical-align: ";
			if (N > 6) ret += "top";
			else if (N < 4) ret += "bottom";
			else ret += "middle";
			ret += ";\n";

			style.Justify = parseInt(style.Justify,10) || 0;


			style.MarginL = parseInt(style.MarginL,10) || 0;
			style.MarginR = parseInt(style.MarginR,10) || 0;
			style.MarginV = parseInt(style.MarginV,10) || 0;

			ret += "margin-top: " + style.MarginV + "px;\n";
			ret += "margin-bottom: " + style.MarginV + "px;\n";


			return ret;
		}
		function parse_head() {
			var info = JSON.parse(JSON.stringify(assdata.info));
			var width = info.PlayResX || video.videoWidth;
			var height = info.PlayResY || video.videoHeight;
			SC.setAttribute("height", height);
			SC.style.height = height + "px";
			SC.setAttribute("width", width);
			SC.style.width = width + "px";
			ScaledBorderAndShadow = info.ScaledBorderAndShadow ? Boolean(info.ScaledBorderAndShadow.toLowerCase() == "yes" || parseInt(info.ScaledBorderAndShadow)) : true;
			TimeOffset = parseFloat(info.TimeOffset) || 0;
			PlaybackSpeed = (100 / info.Timer) || 1;
			renderer.WrapStyle = (info.WrapStyle ? parseInt(info.WrapStyle) : 2);
		}
		function write_styles() {
			if (state == STATES.CANCELING_INIT) return;

			if (!styleCSS) {
				styleCSS = document.createElement("style");
				SC.insertBefore(styleCSS, SC.firstChild);
			}

			var styles = JSON.parse(JSON.stringify(assdata.styles));
			var Default = {
				Name: "Default",
				Outline: 2,
				MarginL: 10,
				MarginR: 10,
				MarginV: 20,
				Blur: 2
			};

			var text = ".subtitle_Default {\n" + style_to_css(Default) + "}\n";
			for (var key in styles) text += "\n.subtitle_" + key + " {\n" + style_to_css(styles[key]) + "}\n";
			styleCSS.innerHTML = text;
			renderer.style = styles;
		}
		function init_subs() {
			if (state == STATES.CANCELING_INIT) return;

			var subtitle_lines = JSON.parse(JSON.stringify(assdata.events));
			var line_num = assdata.events.line;
			var layers = {};
			splitLines = [];
			subtitles = [];

			function createSubtitle(line,num) {
				if (state == STATES.CANCELING_INIT) return;

				var text = line.Text;

				// Remove whitespace at the start and end, and handle '\h'.
				text = text.trim();
				text = text.replace(/\\h/g," ");

				// Fix things that would be displayed incorrectly in HTML.
				text = text.replace(/</g,"&lt;");
				text = text.replace(/</g,"&gt;");

				// Combine adjacent override blocks.
				text = text.replace(/}{/g,"");

				// Fix multiple karaoke effects in one override. Do it twice to catch everything.
				text = text.replace(/{\\(?:K|(?:k[fo]?))([0-9][^}]*?)(\\(?:K|(?:k[fo]?)).*?})/g,"{\\kt$1$2");
				text = text.replace(/{\\(?:K|(?:k[fo]?))([0-9][^}]*?)(\\(?:K|(?:k[fo]?)).*?})/g,"{\\kt$1$2");

				// If the line doesn't start with an override, add one.
				if (text.charAt(0) != "{") text = "{}" + text;

				line.Text = text;


				// Count number of line breaks.
				// Remove soft breaks if they don't apply.
				var breaks = (line.Text.match(/\\N/g) || []).length;
				var qWrap = line.Text.match(/{.*?\\q[0-9].*?}/g);
				if (qWrap) qWrap = +qWrap[qWrap.length-1].match(/[0-9]/);
				if ((qWrap || renderer.WrapStyle) == 2) breaks += (line.Text.match(/\\n/g) || []).length;
				else line.Text = line.Text.replace("\\n"," ");


				// Things that can change within a line, but isn't allowed to be changed within a line in HTML/CSS/SVG.
				// \be, \blur, \bord, \fax, \fay, \fr, \frx, \fry, \frz, \fscx, \fscy, \shad, \xshad, and \yshad
				// Also check for paths because they're always problematic.
				var reProblemBlock = /{.*?\\(?:(?:b(?:e|lur|ord))|(?:f(?:(?:(?:a|sc)[xy])|(?:r[xyz]?)))|(?:[xy]?shad)|(?:p(?:[1-9]|0\.[0-9]*?[1-9]))).*?}/;
				var reProblem = /\\(?:(?:b(?:e|lur|ord))|(?:f(?:(?:(?:a|sc)[xy])|(?:r[xyz]?)))|(?:[xy]?shad)|(?:p(?:[1-9]|0\.[0-9]*?[1-9])))/;

				// These lines kept in case I need them again.
				// \fax, \fr, \fry, \frz, and \fscx change the line width.
				// var reWidth = /\\f(?:(?:(?:a|sc)x)|(?:r[yz]?))[.\\\d}]/;
				// \be, \blur, \bord, \fay, \frx, \fscy, \shad, \xshad, and \yshad don't change the line width.
				// var reNoWidth = /\\(?:(?:b(?:e|lur|ord))|(?:f(?:ay|rx|scy))|(?:[xy]?shad))/;


				// Check for a line break anywhere, or one of the problematic overrides after the first block.
				if (breaks || reProblemBlock.test(line.Text.slice(line.Text.indexOf("}")))) {
					// Split on newlines, then into block-text pairs, then split the pair.
					var pieces = line.Text.split(/\\n/gi).map(x => ("{}"+x).replace("}{","").split("{").slice(1).map(y => y.split("}")));
					var i, megablock = "{", newLine, safe = [""];

					// Merge subtitle line pieces into non-problematic strings.
					for (let piece of pieces) {
						for (let block of piece) {
							megablock += block[0];
							if (reProblem.test(block[0])) safe.push(megablock + "}" + block[1]);
							else safe[safe.length-1] += "{" + block[0] + "}" + block[1];
						}
						safe.push(megablock + "}");
					}

					safe = safe.slice(safe[0] ? 0 : 1, -1).map(s => s.replace("}{",""));
					splitLines.push({line:subtitles.length,pieces:safe.length,breaks:pieces.map(p => p.length)});

					// Create subtitle objects.
					for (i = 0; i < safe.length; ++i) {
						newLine = JSON.parse(JSON.stringify(line));
						newLine.Text = safe[i];
						subtitles.push(NewSubtitle(newLine,num+"-"+(i+1)));
					}
				} else subtitles.push(NewSubtitle(line,num));
			}

			for (var line of subtitle_lines) {
				layers[line.Layer] = true;
				setTimeout(createSubtitle.bind(null,line,line_num++),0);
			}

			for (var layer of Object.keys(layers)) {
				var d = document.createElementNS("http://www.w3.org/2000/svg","g");
					d.setAttribute("id","layer"+layer);
				SC.appendChild(d);
			}
		}

		this.running = () => !paused;
		this.pause = function() {
			paused = true;
		};
		this.resume = function() {
			paused = false;
			if (state == STATES.UNINITIALIZED) renderer.init();
			else if (state == STATES.INITIALIZED) {
				renderer.resize();
				requestAnimationFrame(mainLoop);
			}
		};
		this.resize = function() {
			if (resizeRequest) return;
			resizeRequest = requestAnimationFrame(function() {
				resizeRequest = 0;
				if (state != STATES.INITIALIZED) return;

				var SCP = SC.parentElement;

				// Scale Video
				if (video.videoWidth / video.videoHeight > SCP.clientWidth / SCP.clientHeight) { // increase width
					video.style.width = SCP.clientWidth + "px";
					video.style.height = "auto";
				} else { // increase height
					video.style.width = "auto";
					video.style.height = SCP.clientHeight + "px";
				}

				// Scale Subtitles
				var scaleX = video.clientWidth / parseFloat(SC.style.width);
				var scaleY = video.clientHeight / parseFloat(SC.style.height);
				SC.style.transform = "scale(" + scaleX + ", " + scaleY + ")";
				SC.style.left = ((SCP.clientWidth - video.offsetWidth) / 2) + "px";
				SC.style.top = ((SCP.clientHeight - video.offsetHeight) / 2) + "px";
			});
		};

		this.addEventListeners = function() {
			if (state == STATES.CANCELING_INIT) return renderer.removeEventListeners();
			video.addEventListener("pause",renderer.pause);
			video.addEventListener("play",renderer.resume);
			window.addEventListener("resize",renderer.resize);
			document.addEventListener("mozfullscreenchange",renderer.resize);
			document.addEventListener("webkitfullscreenchange",renderer.resize);
		}
		this.removeEventListeners = function() {
			video.removeEventListener("pause",renderer.pause);
			video.removeEventListener("play",renderer.resume);
			window.removeEventListener("resize",renderer.resize);
			document.removeEventListener("mozfullscreenchange",renderer.resize);
			document.removeEventListener("webkitfullscreenchange",renderer.resize);
		}
		function afterInit() {
			if (state == STATES.CANCELING_INIT) {
				state = STATES.UNINITIALIZED;
				renderer.init();
			} else {
				state = STATES.INITIALIZED;
				if (!paused) renderer.resume();
			}
		}

		this.setSubFile = function(file) {
			subFile = file;
			if (state == STATES.INITIALIZING) state = STATES.CANCELING_INIT;
			else if (state == STATES.INITIALIZED) state = STATES.UNINITIALIZED;
		}
		this.init = function() {
			if (!subFile) return;

			if (state == STATES.INITIALIZING) {
				state = STATES.CANCELING_INIT;
				initRequest.abort();
				return;
			}

			state = STATES.INITIALIZING;

			initRequest = new XMLHttpRequest();
			initRequest.open("get",subFile,true);
			initRequest.onreadystatechange = function() {
				if (this.readyState != 4) return;

				if (state == STATES.CANCELING_INIT) return afterInit();

				renderer.clean();
				assdata = ass2js(this.responseText);

				function templocal() {
					if (state == STATES.CANCELING_INIT) return afterInit();
					video.removeEventListener("loadedmetadata",templocal);
					parse_head();
					setTimeout(write_styles,0);
					setTimeout(init_subs,0);
					setTimeout(renderer.addEventListeners,0);
					setTimeout(afterInit,0);
				}

				// Wait for video metadata to be loaded.
				if (video.readyState) templocal();
				else video.addEventListener("loadedmetadata",templocal);
			};
			initRequest.send();
		};
		this.clean = function() {
			renderer.removeEventListeners();
			if (subtitles) for (let S of subtitles) S.cleanup();
			SC.innerHTML = "<defs></defs>";
			styleCSS = null;
			state = STATES.UNINITIALIZED;
		};

		function mainLoop() {
			if (video.paused) renderer.pause();
			if (paused) return;

			requestAnimationFrame(mainLoop);

			var time = video.currentTime + TimeOffset;
			if (Math.abs(time-lastTime) < 0.01) return;
			lastTime = time;

			// Display Subtitles
			for (var S of subtitles) {
				if (S.time.start <= time && time <= S.time.end) {
					if (S.visible) S.update(time - S.time.start);
					else S.start();
				} else if (S.visible) S.cleanup();
			}

			// Fix position of subtitle lines that had to be split,
			// and border boxes that no longer border their text.
			let transform = SC.style.transform;
			SC.style.transform = "";
			for (let L of splitLines) {
				if (subtitles[L.line].visible && subtitles[L.line].moved) {
					subtitles[L.line].moved = false;


					let A = parseInt(subtitles[L.line].style.Alignment,10);
					let J = subtitles[L.line].style.Justify;
					let widths = [], heights = [], lines;


					// Align Horizontally
					lines = subtitles.slice(L.line,L.line+L.pieces);
					for (let amount of L.breaks) {
						let spans = lines.splice(0,amount);
						let totalWidth = spans.reduce((sum,span) => sum + span.width(), 0);
						let maxHeight;

						// Align the pieces relative to the previous piece.
						if (A%3 == 0) { // Right Alignment
							let previous = spans[0].div.getAttribute("x") - totalWidth + spans[0].width();
							maxHeight = 0;
							for (let span of spans) {
								span.div.setAttribute("x", previous += span.width());
								maxHeight = Math.max(maxHeight,span.height());
							}
						} else if ((A+1)%3 == 0) { // Middle Alignment
							let pWidth = spans[0].width();
							maxHeight = spans[0].height();
							spans[0].div.setAttribute("x", spans[0].div.getAttribute("x") - (totalWidth - pWidth) / 2);
							for (let i = 1; i < spans.length; ++i) {
								let cWidth = spans[i].width(), offset = parseFloat(spans[i-1].div.getAttribute("x"));
								spans[i].div.setAttribute("x", offset + (pWidth + cWidth) / 2);
								pWidth = cWidth;
								maxHeight = Math.max(maxHeight,spans[i].height());
							}
						} else { // Left Alignment
							let previous = spans[0].div.getAttribute("x") - spans[0].width();
							maxHeight = 0;
							for (let span of spans) {
								span.div.setAttribute("x", previous += span.width());
								maxHeight = Math.max(maxHeight,span.height());
							}
						}

						widths.push(totalWidth);
						heights.push(maxHeight);
					}


					// Justify
					if (J && (A-J)%3 != 0) {
						let maxWidth = Math.max(...widths);

						lines = subtitles.slice(L.line,L.line+L.pieces);
						for (let i = 0; i < L.breaks.length; ++i) {
							let amount = L.breaks[i];
							let spans = lines.splice(0,amount);
							let widthDifference = maxWidth - widths[i];

							if (widthDifference) {
								if ((J == 1 && A%3 == 2) || (J == 2 && A%3 == 0)) { // To Left From Center or To Center From Right
									for (let span of spans) {
										let x = parseFloat(span.div.getAttribute("x")) - (widthDifference / 2);
										span.div.setAttribute("x", x);
									}
								} else if (J == 1 && A%3 == 0) { // To Left From Right
									for (let span of spans) {
										let x = parseFloat(span.div.getAttribute("x")) - widthDifference;
										span.div.setAttribute("x", x);
									}
								} else if ((J == 3 && A%3 == 2) || (J == 2 && A%3 == 1)) { // To Right From Center or To Center From Left
									for (let span of spans) {
										let x = parseFloat(span.div.getAttribute("x")) + (widthDifference / 2);
										span.div.setAttribute("x", x);
									}
								} else /*if (J == 3 && A%3 == 1)*/ { // To Right From Left
									for (let span of spans) {
										let x = parseFloat(span.div.getAttribute("x")) + widthDifference;
										span.div.setAttribute("x", x);
									}
								}
							}
						}
					}


					// Align Vertically
					lines = subtitles.slice(L.line,L.line+L.pieces);
					let spans = lines.splice(0,L.breaks[0]);

					// Align the first span.
					let yPos = parseFloat(spans[0].div.getAttribute("y"));
					// Nothing to do for top alignment.
					if (A<7) { // Middle and Bottom Alignment
						if (A>3) yPos += heights[0] - heights.reduce((sum,height) => sum + height, 0) / 2;
						else yPos -= heights.reduce((sum,height) => sum + height, -heights[0]);
						for (let span of spans) span.div.setAttribute("y", yPos);
					}

					// Align the pieces relative to the previous span.
					for (let j = 1; j < L.breaks.length; ++j) {
						yPos += heights[j-1];
						spans = lines.splice(0,L.breaks[j]);
						for (let span of spans) span.div.setAttribute("y", yPos);
					}


					// Fix Border Boxes (if they exist)
					lines = subtitles.slice(L.line,L.line+L.pieces);
					if (lines[0].box) {
						let extents = {
							left: parseFloat(SC.style.width),
							right: 0,
							top: parseFloat(SC.style.height),
							bottom: 0
						};

						// find extents of the entire line
						for (let line of lines) {
							let bbox = line.div.getBBox();
							extents.left = Math.min(extents.left, bbox.x);
							extents.right = Math.max(extents.right, bbox.x + bbox.width);
							extents.top = Math.min(extents.top, bbox.y);
							extents.bottom = Math.max(extents.bottom, bbox.y + bbox.height);

							// hide all boxes
							line.box.style.display = "none";
						}

						// use the first box for all of the pieces
						let firstBox = lines[0].box;
						firstBox.style.display = "";
						firstBox.style.transform = "";
						firstBox.style.transformOrigin = "";
						let B = parseFloat(firstBox.style.strokeWidth);
						firstBox.setAttribute("x", extents.left - B);
						firstBox.setAttribute("y", extents.top - B);
						firstBox.setAttribute("width", (extents.right - extents.left) + 2*B);
						firstBox.setAttribute("height", (extents.bottom - extents.top) + 2*B);
					}
				}
			}
			SC.style.transform = transform;
		}
	}


	/* Subtitle Object
		video:		the <video> element
		container:	the <svg> element
		renderer:	the Renderer object
	*/
	let subtitles = []; // array of all subtitle objects
	let SubtitleManager = {}; // object to return

	SubtitleManager.add = function(video,filepath,show) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (!SubtitleObject) {
			video.classList.add("subtitle_video");

			let SC = document.createElementNS("http://www.w3.org/2000/svg", "svg");
				SC.setAttribute("class", "subtitle_container");
			video.parentElement.appendChild(SC);

			SubtitleObject = {
				video: video,
				container: SC,
				renderer: new Renderer(SC,video)
			};
			subtitles.push(SubtitleObject);
		}

		if (filepath) {
			SubtitleObject.renderer.setSubFile(filepath);
			if (show) {
				SubtitleObject.renderer.init();
				SubtitleObject.renderer.resume();
			}
		}
		SubtitleObject.container.style.display = SubtitleObject.renderer.running() ? "" : "none";
	};

	SubtitleManager.remove = function(video) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (SubtitleObject) {
			SubtitleObject.renderer.clean();
			SubtitleObject.container.remove();
			video.classList.remove("subtitle_video");
			subtitles.splice(subtitles.indexOf(SubtitleObject),1);
		}
	};

	SubtitleManager.show = function(video) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (SubtitleObject) {
			SubtitleObject.renderer.resume();
			SubtitleObject.renderer.addEventListeners();
			SubtitleObject.container.style.display = "";
		}
	};

	SubtitleManager.hide = function(video) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (SubtitleObject) {
			SubtitleObject.container.style.display = "none";
			SubtitleObject.renderer.removeEventListeners();
			SubtitleObject.renderer.pause();
		}
	};

	SubtitleManager.visible = function(video) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		return SubtitleObject ? SubtitleObject.container.style.display != "none" : false;
	};

	SubtitleManager.setSubtitleFile = function(video,filepath) {
		if (!filepath) return;
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (SubtitleObject) SubtitleObject.renderer.setSubFile(filepath);
	};

	SubtitleManager.setBorderStyle = function(video,style) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (SubtitleObject) SubtitleObject.renderer.setBorderStyle(style || 0);
	};

	SubtitleManager.reload = function(video) {
		let SubtitleObject = subtitles.find(S => video == S.video);
		if (SubtitleObject) SubtitleObject.renderer.init();
	};

	return SubtitleManager;
})();
