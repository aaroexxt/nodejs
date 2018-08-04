/*
* fileserve.js by Aaron Becker
* CarOS Node.JS Server
*
* Dedicated to Marc Perkel
*/

/*
 * Copyright (c) 2018 Aaron Becker
 *
 * This software is provided 'as-is', without any express or implied
 * warranty. In no event will the authors be held liable for any damages
 * arising from the use of this software.
 *
 * Permission is granted to anyone to use this software for any purpose,
 * including commercial applications, and to alter it and redistribute it
 * freely, subject to the following restrictions:
 *
 *    1. The origin of this software must not be misrepresented; you must not
 *    claim that you wrote the original software. If you use this software
 *    in a product, an acknowledgment in the product documentation would be
 *    appreciated but is not required.
 *
 *    2. Altered source versions must be plainly marked as such, and must not
 *    be misrepresented as being the original software.
 *
 *    3. This notice may not be removed or altered from any source
 *    distribution.
 */

/*
---- CODE LAYOUT ----

This descriptor describes the layout of the code in this file.
2 main phases: Initialization (I1-I9) and Runtime Code (R1-R2)

Initialization (9 steps):
1) Module Initialization: initalizes modules that are required later on
2) Runtime Info/Settings: Reads and parses runtime information and settings from external JSON file
3) Serial Device Logic: Reads command line arguments and determines valid serial devices to connect to. Also opens a serial port if a valid device is found
4) Arduino Command Handling: defines handling of arduino commands
5) Data File Parsers: parses files that contain information like data for commands and responses for speech matching
6) Neural Network Setup: sets up and trains neural network for processing of speech commands
7) Reading From Stdin: initializes handlers for reading from stdin (arduino commands from stdin)
8) Error and Exit Handling: initializes error & exit (Ctrl+C) handlers
9) Misc. Init Code: Initializes loops for tracking runtimeInformation and sending to clients

Runtime Code (2 steps):
1) HTTP Server Setup/Handling: sets up the HTTP server, also sets up socket.io connection
2) Socket.IO Connection Logic: large chunk of code which responds to client websocket connections

*/

/**********************************
--I1-- MODULE INITIALIZATION --I1--
**********************************/

var http = require('http');
var url = require('url');
var fs = require('fs');
var utils = require('./nodeutils.js'); //include the utils file

var formidable = require('formidable');
var debughttp = require('debug')('http');
var debuginit = require('debug')('init');
var debugfile = require('debug')('upload');
var singleLineLog = require('single-line-log').stdout; //single line logging

var denyFileNames = ["pass.json","rpibackend.py","COSserver.js","nodeutils.js","training.py","live.py","commands.json","responses.json","commandGroup.json"]; //files that the server should not serve
var ignoreDenyFileExtensions = true;
var appendCWDtoRequest = true;

var securityOff = true; //PLEASE REMOVE THIS, FOR TESTING ONLY
var catchErrors = false; //enables clean error handling. Only turn off during development

var sockets = [];
var pyimgnum = 0; //python image counter
var pyimgbasepath = cwd+"/index/tmpimgs/";

var userPool = new utils.authPool(); //AuthPool that keeps track of sessions and users



var windowPlugin = require('window-size');
var windowSize = windowPlugin.get();
process.stdout.on('resize', function() {
	windowSize = windowPlugin.get();
	console.log("Updated terminal size to width: "+windowSize.width+", height: "+windowSize.height);
});

/**********************************
--I2-- RUNTIME INFO/SETTINGS --I2--
**********************************/

var runtimeSettings = {
	faces: "",
	passes: "",
	maxVideoAttempts: "",
	maxPasscodeAttempts: ""
}; //holds settings like maximum passcode tries
var runtimeInformation = {
	frontendVersion: "?",
	backendVersion: "?",
	heartbeatMS: "?",
	nodeConnected: true,
	pythonConnected: false,
	arduinoConnected: false //set here and not in settings.json so it is not overridden

}; //holds information like version

var cwd = __dirname;

try {
	var settingsData = fs.readFileSync(cwd+"/settings.json");
} catch(e) {
	console.error("[FATAL] Error reading info/settings file");
	throw "[FATAL] Error reading info/settings file";
}

settingsData = JSON.parse(settingsData);
if (typeof settingsData.settings.unscrambleKeys == "undefined") {
	console.error("UnscrambleKeys undefined in runtimeSettings, not unscrambling. This may result in no users being able to login");
	throw "UnscrambleKeys undefined in runtimeSettings, not unscrambling. This may result in no users being able to login";
} else {
	var keys = Object.keys(settingsData.settings);
	for (var i=0; i<keys.length; i++) {
		if (settingsData.settings.unscrambleKeys.indexOf(keys[i]) > -1) {
			runtimeSettings[keys[i]] = [];
			for (var j=0; j<settingsData.settings[keys[i]].length; j++) {
				runtimeSettings[keys[i]][j] = utils.atob(settingsData.settings[keys[i]][j]); //undo atob encryption
			}
		} else {
			runtimeSettings[keys[i]] = settingsData.settings[keys[i]]; //undo atob encryption
		}
	}
}

var keys = Object.keys(settingsData.information); //only override keys from settingsData
for (var i=0; i<keys.length; i++) {
	runtimeInformation[keys[i]] = settingsData.information[keys[i]];
}

//console.clear();
console.log('\033c')
console.log("~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-\nCarOS V1\nBy Aaron Becker\nPORT: "+runtimeSettings.serverPort+"\nCWD: "+cwd+"\n~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-\n");

/********************************
--I3-- SERIAL DEVICE LOGIC --I3--
********************************/

var serialDevice = "none";
var foundJSON = false;
process.argv.forEach(function (val, index, array) {
	function processDeviceJSON(raw) {
		try {
			var json = JSON.parse(raw.trim());
		} catch(e) {
			console.log("Error parsing JSON. E: "+e+", raw: "+raw);
			var json = "";
		}
		for (var i=0; i<json.length; i++) {
			var device = json[i].comName;
			var manufacturer = json[i].manufacturer || "No manufacturer found";
			console.log("Device parsed from json: "+device+", manufacturer: "+manufacturer);
			if (manufacturer.indexOf("Arduino") > -1 || manufacturer.indexOf("arduino") > -1) {
				console.log("Arduino found!");
				runtimeInformation.arduinoConnected = true;
				serialDevice = device;
			}
		}
	}
	var ind = val.indexOf("serial=");
	var ind2 = val.indexOf("listtype=");
	if (ind > -1) {
		serialDevice = val.split("=")[1];
		if (foundJSON) {
			processDeviceJSON(serialDevice);
		} else {
			runtimeInformation.arduinoConnected = true;
		}
	} else if (ind2 > -1) {
		var listType = val.split("=")[1];
		if (listType == "JSON") {
			console.log("JSON list detected");
			if (serialDevice == "" || serialDevice == "none") { //process later
				foundJSON = true;
			} else {
				processDeviceJSON(serialDevice);
			}
		}
	}
});
console.log("Serial device from start script: "+serialDevice);
var SerialPort = require('serialport');
if (serialDevice == "" || serialDevice == "none" || runtimeInformation.arduinoConnected == false) {
	console.warn("[WARNING] Server running without arduino. Errors may occur. Once you have connected an arduino, you have to relaunch the start script.");
	var arduino = { //make a fake arduino class so that server doesnt fail on write
		write: function(t) {
			console.warn("[WARNING] Arduino.write method called with no arduino connected, data is literally going nowhere");
		}
	}
} else {
	var arduino = new SerialPort(serialDevice, {
		baudRate: runtimeSettings.arduinoBaudRate,
		autoOpen: false
	});
	arduino.open(function (err) { //and open the port
		if (err) { //arduino was connected in previous server iteration and was disconnected?
			console.error("Error opening serial port to arduino at "+serialDevice+".");
			runtimeInformation.arduinoConnected = false;
			console.warn("[WARNING] Server running without valid arduino. Errors may occur. Once you have reconnected an arduino, you have to relaunch the start script (unless it is on the same port).");
			var arduino = { //make a fake arduino class so that server doesn't fail on write
				write: function(t) {
					console.warn("[WARNING] Arduino.write method called with no arduino connected, data is literally going nowhere");
				}
			}
		} else {
			console.log("Arduino connected successfully")
			runtimeInformation.arduinoConnected = true;
			arduino.on('readable', function(data) {
				handleArduinoData(arduino.read());
			})
		}
	})
}

/*************************************
--I4-- ARDUINO COMMAND HANDLING --I4--
*************************************/

var arduinoCommandSplitChar = ";";
var arduinoCommandValueChar = "|";

var arduinoCommandBuffer = ""; //need buffer because might not recieve whole command in one recieve
function handleArduinoData(data) {
	var command = arduinoCommandBuffer;
	var sdata = String(data).split("");
	for (var i=0; i<sdata.length; i++) {
		if (sdata[i] == arduinoCommandSplitChar) {
			var split = arduinoCommandBuffer.split(arduinoCommandValueChar);
			if (split.length == 1) {
				console.log("ARDUINO buf "+arduinoCommandBuffer+", no value in command")
				arduinoCommandRecognized(arduinoCommandBuffer,null);
			} else if (split.length == 2) {
				console.log("ARDUINO buf "+arduinoCommandBuffer+", single value found")
				arduinoCommandRecognized(split[0],split[1]);
			} else if (split.length > 2) {
				console.log("ARDUINO buf "+arduinoCommandBuffer+", multiple values found")
				var values = [];
				for (var i=1; i<split.length; i++) {
					values.push(split[i]);
				}
				arduinoCommandRecognized(split[0],values);
			}
			arduinoCommandBuffer = "";
		} else {
			arduinoCommandBuffer+=sdata[i];
		}
	}
}
function arduinoCommandRecognized(command,value) {
	switch(command) {
		case "AOK": //arduino tells server that it is ok
			arduino.write("SOK"); //tell arduino that server is ready
			break;
		case "CONN": //arduino tells server that it is connected
			console.log("Arduino is connected :)");
			break;
		case "INFO": //arduino requested server information
			console.log("Arduino has requested information, sending");
			sendArduinoCommand("uptime",runtimeInformation.uptime);
			sendArduinoCommand("status",runtimeInformation.status);
			sendArduinoCommand("users",runtimeInformation.users);
			break;
		case "OTEMP": //arduino reports outside temperature
			console.log("Outside arduino temp report "+value);
			runtimeInformation.outsideTemp = Number(value);
			break;
		case "ITEMP": //arduino reports inside temperature
			console.log("Inside arduino temp report "+value);
			runtimeInformation.insideTemp = Number(value);
			break;
		case "CARCOMM": //yee it's a car command! work on this later ;)
			break;
		default:
			console.error("Command "+command+" not recognized as valid arduino command");
			break;
	}
	console.log("Complete command recognized: "+command+", value(s): "+JSON.stringify(value));
}
function sendArduinoCommand(command,value) {
	arduino.write(command+arduinoCommandValueChar+value+arduinoCommandSplitChar);
}

/******************************
--I5-- DATA FILE PARSERS --I5--
******************************/

fs.readFile(cwd+"/responses.json", function(err,data){
	if (err) {
		console.error("[FATAL] Error reading responses file");
		throw "[FATAL] Error reading responses file";
	} else {
		var responseData = [];
		var commands = JSON.parse(data); //read data and set approval object
		for (var i=0; i<commands.length; i++) {
			responseData.push(commands[i]);
		}
		console.log("[SPEECHPARSE] Sentences in response data: "+responseData.length);
		console.log("[SPEECHPARSE] Preprocessing data...");
		speechParser.algorithm.preprocessData(responseData);
		console.log("[SPEECHPARSE] Data preprocessed successfully.");
	}
});

fs.readFile(cwd+"/commandGroup.json", function(err,data){
	if (err) {
		console.error("[FATAL] Error reading commandGroup file");
		throw "[FATAL] Error reading commandGroup file";
	} else {
		var lines = JSON.parse(data); //read data and set approval object
		var foundCommandGroup = false;
		var commands = [];
		for (var i=0; i<lines.length; i++) {
			if (lines[i].type == "commandGroup") {
				speechParser.algorithm.commandGroup = lines[i].commandGroup;
				foundCommandGroup = true;
			} else if (lines[i].type == "command") {
				commands.push([lines[i].command,lines[i].response,lines[i].arguments]);
			}
		}
		if (!foundCommandGroup) {
			throw "[FATAL] No commandGroup found in commandGroup file.";
		} else if (commands.length != speechParser.algorithm.commandGroup.length) {
			throw "[FATAL] CommandGroup length does not match command length. Are there commands missing from the commandGroup file? (command length: "+commands.length+", cg length: "+speechParser.algorithm.commandGroup.length;
		} else {
			speechParser.algorithm.commandFunctions = commands;
		}
	}
});

fs.readFile(cwd+"/commands.json", function(err,data){
	if (err) {
		console.error("[FATAL] Error reading commands file");
		throw "[FATAL] Error reading commands file";
	} else {
		var speechData = [];
		var commands = JSON.parse(data); //read data and set approval object
		for (var i=0; i<commands.length; i++) {
			speechData.push(commands[i]);
		}
		console.log("[SPEECHNET] Sentences in speech training data: "+speechData.length);
		console.log("[SPEECHNET] Preprocessing data...");
		neuralMatcher.algorithm.preprocessData(speechData);
		console.log("[SPEECHNET] Generating training data...");
		var td = neuralMatcher.algorithm.generateTrainingData(); //uses preprocessed data
		console.log("[SPEECHNET] Training net (won't show progress on chrome console)...");
		neuralMatcher.algorithm.trainNetAsync(speechClassifierNet, speechNetTargetError, td,
		function(net){
			var percent = speechNetTargetError/net.error;
			var chars = Math.round(windowSize.width*percent);
			var str = "";
			for (var i=0; i<chars-6; i++) {
				str+="#";
			}
			str+="> ";
			str+=String(Math.round(percent*100))
			str+="%"
			singleLineLog(str); //make it fancy
			//singleLineLog("training error: "+net.error+", iterations: "+net.iterations);
		},
		function(){
			singleLineLog.clear();
			console.log("\n[SPEECHNET] Done training net. Ready for input.");
			speechNetReady = true;
		},
		function(){
			console.error("[SPEECHNET] Error training net asynchronously. Speech-related functions may break :(");
		})
	}
});

/*********************************
--I6-- NEURAL NETWORK SETUP --I6--
*********************************/

var speechParser = require('./speechParser.js'); //include speech parsing file
var neuralMatcher = require('./speechMatcher.js'); //include the speech matching file
neuralMatcher.algorithm.stemmer = neuralMatcher.stemmer;
var brain = require("brain.js");
var speechClassifierNet = new brain.NeuralNetwork(); //make the net
var speechNetTargetError = 0.005;//0.00001; //<- for release
var speechNetReady = false;

/*******************************
--I7-- READING FROM STDIN --I7--
*******************************/

var stdinput = process.openStdin();
var stdinputListener = new utils.advancedEventListener(stdinput,"data");
var sendArduinoMode = false;
stdinputListener.addPersistentListener("*",function(d) {
	var uI = d.toString().trim();
	console.log("you entered: [" + uI + "]");
	if (uI == "help") {
		console.log("Right now, sA or sendArduinoMode toggles sending raw to arduino.")
	} else if (uI == "sA" || uI == "sendArduinoMode") {
		sendArduinoMode = !sendArduinoMode;
		console.log("Send arduino mode toggled");
	} else {
		if (sendArduinoMode) {
			arduino.write(uI+arduinoCommandSplitChar);
		} else {
			console.log("Command not recognized")
		}
	}
});

/************************************
--I8-- ERROR AND EXIT HANDLING --I8--
************************************/

process.on('SIGINT', function (code) { //on ctrl+c or exit
	console.log("\nSIGINT signal recieved, graceful exit (garbage collection) w/code "+code);
	runtimeInformation.status = "Exiting";
	sendArduinoCommand("status","Exiting");
	for (var i=0; i<sockets.length; i++) {
		sockets[i].socket.emit("pydata","q"); //quit python
		sockets[i].socket.emit("POST",{"action": "runtimeInformation", "information":runtimeInformation}); //send rti
		sockets[i].socket.emit("disconnect","");
	}
	console.log("Unlinking OpenCV image files...");
	for (var i=pyimgnum; i>=0; i--) {
		var path = pyimgbasepath+"in/image"+i+".png";
		console.log("Removing image file (in): "+path);
		fs.unlink(path,function (err) {
			console.log("Error removing?: "+err)
		})
		var path = pyimgbasepath+"out/image"+i+".jpg";
		console.log("Removing image file (out): "+path);
		fs.unlink(path,function (err) {
			console.log("Error removing?: "+err)
		})
	}
	console.log("Exiting in 1500ms (waiting for sockets to send...)");
	setTimeout(function(){
		process.exit(); //exit completely
	},1500); //give some time for sockets to send
});
if (catchErrors) {
	process.on('uncaughtException', function (err) { //on error
		console.log("\nError signal recieved, graceful exiting (garbage collection)");
		sendArduinoCommand("status","Error");
		runtimeInformation.status = "Error";
		for (var i=0; i<sockets.length; i++) {
			sockets[i].socket.emit("pydata","q"); //quit python
			sockets[i].socket.emit("POST",{"action": "runtimeInformation", "information":runtimeInformation}); //send rti
			sockets[i].socket.emit("disconnect","");
		}
		console.log("Unlinking OpenCV image files...");
		for (var i=pyimgnum; i>=0; i--) {
			var path = pyimgbasepath+"in/image"+i+".png";
			console.log("Removing image file (in): "+path);
			fs.unlink(path,function (err) {
				console.log("Error removing?: "+err)
			});
			var path = pyimgbasepath+"out/image"+i+".jpg";
			console.log("Removing image file (out): "+path);
			fs.unlink(path,function (err) {
				console.log("Error removing?: "+err)
			});
		}
		console.log("\nCRASH REPORT\n-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~\nError:\n"+err+"\n-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~-~\n");
		console.log("Exiting in 1500ms (waiting for sockets to send...)");
		setTimeout(function(){
			process.exit(); //exit completely
		},1500); //give some time for sockets to send
	});
}

/****************************
--I9-- MISC. INIT CODE --I9--
****************************/

var statusUpdateInterval = setInterval(function(){
	var time = process.uptime();
	var uptime = utils.formatHHMMSS(time); //rts.uptime
	runtimeInformation.uptime = uptime;
	runtimeInformation.users = userPool.auth_keys.length //rts.users
	if (runtimeInformation.status.toLowerCase() != "running") {
		console.log("Sending runtimeinfo because of status change");
		allemit('POST', {"action": "runtimeInformation", "information":runtimeInformation})
	}
},1000);
runtimeInformation.status = "Running";

/***************************************
--R1-- HTTP SERVER SETUP/HANDLING --R1--
***************************************/

//APPENDCWDTOREQUEST

debuginit("~-Server Created Successfully-~");

var express = require("express");
var app = express();
var server = http.Server(app);
var io = require('socket.io')(server);
var finalHandler = require('finalhandler');
var serveFavicon = require('serve-favicon');

server.listen(runtimeSettings.serverPort, function() {
	console.log((new Date()) + ' Node server is listening on port ' + runtimeSettings.serverPort);
})

app.use(serveFavicon(cwd+"/index/assets/images/favicon.ico"));

app.use(express.static(cwd+"/index/assets"))

app.get("/client", function(req, res) {
	var done = finalHandler(req, res, {
		onerror: function(err) {
			console.log("[HTTP] Error: "+err.stack || err.toString())
		}
	});

	fs.readFile(cwd+'/index/COS.html', function (err, buf) {
		if (err) return done(err)
		//res.setHeader('Content-Type', 'text/html')
		res.end(buf)
	})
})



/***************************************
--R2-- SOCKET.IO CONNECTION LOGIC --R2--
***************************************/

io.on('connection', function (socket) { //on connection
	sockets[sockets.length] = {socket: socket, type: "uninitialized", status: "init", id: socket.id, handler: undefined, authkey: "uninitialized"};
	var socketid = sockets.length-1;
	var socketuid = socket.id;
	var track = sockets[socketid];
	var socketHandler = new utils.socketHandler(userPool,sockets);
	track.handler = socketHandler;

	socket.on('initweb', function (data) { //set up listener for web intialization
		track.status = "connected";
		track.type = "client";
		initweb(data,socket,socketHandler,track);
	});
	socket.on('initpython', function (data) { //set up listener for python initialization
		initpython(data,socket,socketHandler,track);
		track.status = "connected";
		track.type = "python";
		runtimeInformation.pythonConnected = true;
		socket.on('disconnect', function (data) { //we know that it is the python socket, setup listener to emit pydisconnect
			console.log("PYDISCONNECT")
			sockets[socketid].status = "disconnected";
			allemit('pydisconnect',{});
			runtimeInformation.pythonConnected = false;
		})
	});

	socket.on("GET", function (data) { //make it nice! like one unified action for all commands
		socketHandler.update(userPool,sockets); //update socketHandler
		var action = data.action;
		var key = data.authkey;
		if (typeof key == "undefined") {
			key = data.key;
		}
		var keyObject = userPool.findKey(key);
		var keyObjectValid = true;
		if (keyObject == null || typeof keyObject == "undefined") {
			keyObjectValid = false;
		}
		var validKey = userPool.validateKey(key);
		var processeddata = data.data;
		//console.log("OPENCVALLOWED? "+((keyObjectValid == true)?keyObject.properties.allowOpenCV:"invalid keyObject"))
		if ((track.type == "uninitialized" || true)) { //different actions based on tracking type, if uninit just give all
			switch(action) {
				/*GENERAL ACTIONS*/
				case "validatekey":
					var ok = validKey;
					if (ok == true) {
						console.log("Validating authkey: "+key+", valid=true");
						socketHandler.socketEmitToWeb('POST', {"action": "validatekey", "valid": "true"})
					} else {
						console.log("Validating authkey: "+key+", valid=false");
						socketHandler.socketEmitToWeb('POST', {"action": "validatekey", "valid": "false"})
					}
					break;
				case "readback":
					console.log("Reading back data: "+JSON.stringify(data));
				break;
				case "requestRuntimeInformation": //valid key not required
					console.log("Runtime information requested");
					socketHandler.socketEmitToWeb('POST', {"action": "runtimeInformation", "information": runtimeInformation});
				break;
				case "retreiveSoundcloudCache": //retreive cache from client
					if (validKey || securityOff) {
						var cf = runtimeSettings.soundcloudCacheFile;
						console.log("Retreiving soundcloudCache from '"+cf+"'");
						fs.readFile(cwd+"/"+cf, function(err, data) {
							if (err) {
								console.warn("No soundcloud cache file found");
								socketHandler.socketEmitToWeb('POST', {"action": "returnSoundcloudCache", hasCache: false});
							} else {
								try {
									var scCache = JSON.parse(data);
									if (scCache.expiryTime && scCache.cache) {
										var d = new Date().getTime();
										if (d-scCache.expiryTime < runtimeSettings.soundcloudCacheExpiryTime) { //is cache ok?
											console.log("Valid soundcloud cache file found; sending to client");
											socketHandler.socketEmitToWeb('POST', {"action": "returnSoundcloudCache", hasCache: true, cache: scCache, cacheLength: scCache.length});
										} else { //aww it's expired
											console.warn("Soundcloud cache is expired; deleting");
											fs.unlink(cwd+"/"+cf,function(err) {
												if (err != null) {
													console.error("Error unlinking expired soundcloud cache");
												}
											});
											socketHandler.socketEmitToWeb('POST', {"action": "returnSoundcloudCache", hasCache: false, error: "cachExpired"});
										}
									} else {
										console.warn("Soundcloud track cache is invalid (missing expiryTime and cache tags)");
										socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "errorParsingSoundCloudCache"});
									}
								} catch(e) {
									console.warn("Soundcloud track cache is invalid (couldn't parse JSON)");
									socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "errorParsingSoundCloudCache"});
								}
							}
						});
					} else {
						socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "clientInvalidKey"});
					}
				break;
				case "clientHasSoundcloudCache": //recieving sc cache from client
					if (validKey || securityOff) {
						if (data.cacheLength > 0) {
							try {
								try {
									var scCache = JSON.parse(data.cache);
								} catch(e) {
									var scCache = data.cache;
								}
								var expiry = new Date().getTime()+runtimeSettings.soundcloudCacheExpiryTime;
								var writeableCache = {
									expiryTime: expiry,
									cache: scCache
								}
								var toWrite = JSON.stringify(writeableCache);
								fs.writeFile(cwd+"/"+runtimeSettings.soundcloudCacheFile, toWrite, function(err) {
									if (err != null) {
										console.error("Error writing SC Cache file "+err);
									}
								})
							} catch(e) {
								socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "errorParsingSoundCloudCache"});
							}
						} else {
							socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "soundCloudCacheLengthInvalid"});
						}
					} else {
						socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "clientInvalidKey"});
					}
				break;
				/*OPENCV HANDLERS*/
				//yes I know I can use single line comments
				case "login-imageready":
					if (securityOff) {console.warn("WARNING: opencv security protections are OFF");}
					if (keyObjectValid) {
						if (typeof keyObject.properties.videoAttemptNumber == "undefined") {
							console.error("keyObject videoAttemptNumber undefined, erroring");
							socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "OpenCVClientVideoAttemptPropertyUndefined"});
						} else {
							if ((validKey || securityOff) && keyObject.properties.videoAttemptNumber < runtimeSettings.maxVideoAttempts) {
								if (keyObject.properties.allowOpenCV) {
									console.log("recv imgdata");
									var raw = data.raw;
									raw = raw.replace(/^data:image\/\w+;base64,/, "");
									var b = new Buffer(raw, 'base64');
									var path = pyimgbasepath+"in/image"+pyimgnum+".png";
									fs.writeFile(path, b, function(err) {
										console.log("Wrote file error?: "+err);
									});
									socketHandler.socketEmitToID(socket.id,"POST",{ action: "login-opencvqueue", queue: pyimgnum });
									console.log("Sending to opencv");
									keyObject.properties.allowOpenCV = false;
									if (securityOff) {
										allemit("pydata","i:"+pyimgnum) //Sync imagenum variable
										allemit("pydata","o:"+path+","+key); //send with 'o' flag to tell python that it's face recognition
									} else {
										socketHandler.socketEmitToPython("pydata","i:"+pyimgnum) //Sync imagenum variable
										socketHandler.socketEmitToPython("pydata","o:"+path+","+key); //send with 'o' flag to tell python that it's face recognition
									}
									/*allon(("opencvresp:"+pyimgnum), function (data) {
										console.log("data from opencv "+JSON.stringify(data));
									});*/
									pyimgnum++;
								} else {
									console.log("no response recieved yet from opencv, client sending too fast??");
									socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "OpenCVClientResponseNotAttainedFromPrevRequest", longerror: "Python response from previous request has not been attained, waiting."});
								}
							} else {
								console.log("Client invalid for opencv processing");
								if (!validKey) {
									socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "OpenCVClientInvalidKey"});
								} else {
									socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "OpenCVClientVideoAttemptsExceeded"});
								}
							}
						}
					} else {
						console.error("keyObject invalid w/key '"+key+"'");
						socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "OpenCVClientInvalidKeyObject"});
					}
					//console.log(raw)
					/*var b = new Buffer(raw.length);
					var c = "";
					for (var i=0; i<raw.length; i++) {
						b[i] = raw[i];
						c = c + " " + raw[i];
					}
					fs.writeFile(pyimgbasepath+"in/image"+pyimgnum+".jpg",c,"binary",function(err) {
						console.log("write error?: "+err)
					})*/
				break;
				case "login-opencvresponse":
					if (typeof data == "undefined") {
						console.log("dat opencv response undefined!!! uhoh");
					} else {
						var dat = data.data;
						var innum = dat.imgnum;
						var pathout = dat.path;
						var pykey = dat.key;
						if (innum == "error" || path == "error") {
							console.error("Some internal python error ocurred :(");
							socketHandler.socketEmitToKey(pykey,"POST",{action: "processingError", error: "OpenCVBackendServerError"});
						} else {
							var conf = dat.confidences.split(",");
							var labels = dat.labels.split(",");
							var rects = dat.rects.split(",[");
							var maxVidAttempts = runtimeSettings.maxVideoAttempts;
							var vidAttempt = -1;
							var pykeyObject = userPool.findKey(pykey);
							if (pykeyObject == null) {
								console.error("PyKey "+pykey+" not found in userPoolDB. Was request made before server restart?");
								socketHandler.socketEmitToID(socket.id,"POST",{action: "processingError", error: "OpenCVClientMissingKey, key:"+pykey});
							} else if (typeof pykeyObject.properties.videoAttemptNumber !== "number") {
								socketHandler.socketEmitToKey(pykey,"POST",{action: "processingError", error: "OpenCVClientKeyMissingVidAttemptProperty"});
								console.error("VidAttempt not valid on key "+pykey);
							} else {
								vidAttempt = pykeyObject.properties.videoAttemptNumber;
								//console.log("checked key "+pykey+" for prop vidAttempt");
								//console.log(conf,labels,rects,pykey)
								for (var i=0; i<rects.length; i++) { //fix removal of colons
									if (rects[i] !== "") {
										if (rects[i].substring(0,1) !== "[") { //fix if not containing starter bracket
											rects[i] = "["+rects[i];
										}
										//console.log("rectsi "+rects[i])
										rects[i] = JSON.parse(rects[i]); //parse the data
									}
								}
								fs.unlink(pyimgbasepath+"/in/image"+innum+".png",function(err){
									console.log("Error removing?: "+err);
								})
								//console.log("pathout "+pathout);
								fs.readFile(pathout, function(err, buf) {
									if (buf) {
										var approved = false;
										for (var i=0; i<labels.length; i++) {
											for (var j=0; j<runtimeSettings.faces.length; j++) {
												console.log("label "+labels[i]+", face "+runtimeSettings.faces[j])
												if (labels[i] === runtimeSettings.faces[j]) {
													approved = true;
												}
											}
										}
										if (approved) {
											pykeyObject.properties.approved = true;
											console.log("modified key "+pykey+" with approved attrib")
										} else {
											pykeyObject.properties.videoAttemptNumber += 1;
											vidAttempt += 1;
											console.log("modified key "+pykey+" with attempt attrib")
										}
										socketHandler.socketEmitToKey(pykey, "POST", {action: 'login-opencvdata', queue: innum, buffer: buf.toString('base64'), confidences: conf, labels: labels, rects: rects, approved: approved, totalAttempts: maxVidAttempts, attemptNumber: vidAttempt }); //use new unique id database (quenum) so authkeys are not leaked between clients
										pykeyObject.properties.allowOpenCV = true; //reallow sending opencv because processing is completed
										fs.unlink(pathout, function(err) {
											console.log("Error removing sent img?: "+err);
										})
									} else {
										console.error("Buffer was undefined when attempting to read from pathout returned from python.")
									}
								})
							}
						}
					}
				break;
				case "login-passcodeready":
					if (securityOff) {console.warn("WARNING: passcode security protections are OFF");}
					if (validKey || securityOff) {
						console.log("Authkey "+data.authkey+" approved");
						var passok = false;
						for (var i=0; i<runtimeSettings.passes.length; i++) {
							if (runtimeSettings.passes[i] == data.passcode) {
								console.log("Pass "+data.passcode+" approved");
								passok = true;
							} else {
								console.log("Pass "+data.passcode+" denied");
							}
						}
						if (passok) {
							socketHandler.socketEmitToKey(key,"POST", {action: 'login-passcodeapproval', approved: true});
							if (keyObjectValid) {
								keyObject.properties.approved = true;
							} else {
								socketHandler.socketEmitToKey(key,"POST", {action: 'processingError', error: "loginPasscodeKeyObjectInvalid"});
							}
						} else {
							socketHandler.socketEmitToKey(key,"POST", {action: 'login-passcodeapproval', approved: false});
						}
					} else {
						console.log("Authkey "+data.authkey+" denied");
					}
				break;
				case "pydata":
					if (securityOff) {console.warn("WARNING: pydata security protections are OFF");}
					if (validKey || securityOff) {
						console.log("Authkey "+data.authkey+" approved")
						if (securityOff) {
							allemit('pydata',data.data);
						} else {
							socketHandler.socketEmitToPython('pydata',data.data);
						}
					} else {
						console.log("Authkey "+data.authkey+" denied");
					}
				break;
				case "processSpeech":
					if (securityOff) {console.warn("WARNING: processSpeech security protections are OFF");}
					if (validKey) {
						if (keyObjectValid || securityOff) {
							if (keyObject.properties.approved || securityOff) {
								if (speechNetReady) {
									console.log("processing speech: '"+JSON.stringify(data.speech)+"'");
									var classifiedSpeech = []; //array to hold speech that is classified
									if (data.speech.constructor === Array) { //array of possibilities?
										var classifications = []; //array of potential classifications
										for (var i=0; i<data.speech.length; i++) { //part 1: get all possibilities
											console.log("running speech possibility: "+data.speech[i]);
											var classification = neuralMatcher.algorithm.classify(speechClassifierNet, data.speech[i]);
											if (classification.length > 0) {
												classifiedSpeech.push(data.speech[i]);
											}
											console.log("Speech classification: "+JSON.stringify(classification));
											for (var j=0; j<classification.length; j++) {
												var category = classification[j][0];
												var confidence = classification[j][1];

												var contains = false;
												var containIndex = -1;
												for (var b=0; b<classifications.length; b++) {
													if (classifications[b][0] == category) {
														contains = true;
														containIndex = b;
													}
												}
												if (contains) {
													console.log("contains, push _ cat="+category+", conf="+confidence);
													classifications[containIndex][1].push(confidence);
												} else {
													console.log("no contain, not averaging _ cat="+category+", conf="+confidence);
													classifications[classifications.length] = classification[j];
													classifications[classifications.length-1][1] = [classifications[classifications.length-1][1]];
												}
											}
										}
										var max = 0;
										for (var i=0; i<classifications.length; i++) { //part 2: total possibilities
											if (classifications[i][1].length > 1) {
												console.log("averaging "+JSON.stringify(classifications[i][1]));
												var tot = 0;
												var len = classifications[i][1].length;
												for (var j=0; j<classifications[i][1].length; j++) {
													tot += classifications[i][1][j];
												}
												var avg = tot/len;
												if (tot > max) {
													max = tot;
												}
												console.log("avg="+avg+", tot="+tot)
												classifications[i][1] = avg*tot; //multiply by total to weight more answers (I know this results in just total)
											}
										}
										for (var i=0; i<classifications.length; i++) { //part 3, scale by max
											console.log("Scaling classification "+classifications[i][1]+" by max val "+max);
											if (max == 0) {
												console.warn("Dividing factor max is 0, did you pass only a single word in an array?");
											} else {
												classifications[i][1] /= max;
											}
										}
										var finalClassifications = [];
										for (var i=0; i<classifications.length; i++) {
											if (classifications[i][1] > neuralMatcher.algorithm.cutoffOutput) {
												finalClassifications.push(classifications[i]);
											}
										}
										console.log("classifications: "+JSON.stringify(classifications)+", cutoff filtered classifications: "+JSON.stringify(finalClassifications));
										//pick the more likely response from the ones provided
										var likelyResponse = ["",[0]];
										for (var i=0; i<finalClassifications.length; i++) {
							
											if (finalClassifications[i][1] > likelyResponse[1]) {
												likelyResponse = finalClassifications[i];
											}
										}
										var response;
										if (likelyResponse.constructor == Array && likelyResponse[0] !== "" && likelyResponse[1][1] !== 0) {
											speechParser.algorithm.addRNGClass(likelyResponse[0]); //generate rng class from classification
											response = speechParser.algorithm.dumpAndClearQueue();
										} else {
											console.warn("Likelyresponse is blank, what happened?")
											response = "";
										}
										socketHandler.socketEmitToKey(key,"POST",{action: "speechMatchingResult", classification: finalClassifications, likelyResponse: likelyResponse, transcript: data.speech, classifiedTranscript: classifiedSpeech, response: response});
									} else {
										var classification = neuralMatcher.algorithm.classify(speechClassifierNet, data.speech); //classify speech
										console.log("Speech classification: "+JSON.stringify(classification));
										var response;
										if (classification.constructor == Array && classification.length > 0) {
											speechParser.algorithm.addRNGClass(classification[0][0]); //generate rng class from classification
											response = speechParser.algorithm.dumpAndClearQueue(); //dump queue to response (if backed up w/multiple calls)
										} else {
											console.warn("Classification length is 0, response is nothing")
											response = "";
										}
										socketHandler.socketEmitToKey(key,"POST",{action: "speechMatchingResult", classification: classification, transcript: data.speech, classifiedTranscript: classifiedSpeech, response: response});
									}
								} else {
									socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "speechNetNotReady"});
								}
							} else {
								socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "ProcessSpeechClientKeyNotApproved, key: "+key});
							}
						}
					} else {
						socketHandler.socketEmitToKey(key,"POST",{action: "processingError", error: "ProcessSpeechKeyInvalid, key:"+key});
					}
				break;
				default:
					console.error("Recieved invalid action "+action+" from key "+key);
				break;
			}
		}
	})
/*
socket shenanigans (thx jerry)
{"type":2,"nsp":"/","data":["opencvresp:0",{"image":"true","data":"0,/Users/Aaron/Desktop/Code/nodejs/index/tmpimgs/out/image0.jpg"}]}
{"type":2,"nsp":"/","data":["pyok",""]}

*/
	socket.on('gpio', function(data) {}) //why is this here?
});

function initpython(data,socket,socketHandler,track) {
	//console.log("RECV SOCKET INIT PYTHON "+JSON.stringify(data));
	if (securityOff) {
		console.warn("WARNING: Python security is OFF")
		allemit('pycwd', cwd); //emit cwd
	} else {
		socketHandler.socketEmitToPython('pycwd', cwd); //check if python script is running
	}
	socketHandler.socketEmitToWeb('webready', {data: "ready?"}); //check if there is a web browser connected
	allon('webok', function (data) { //if there is, send data
		//console.log("RECV SOCKET INIT WEB "+JSON.stringify(data));
		socketHandler.socketEmitToWeb('webdata',{data: "SEND!"});
	});
}
function initweb(data,socket,socketHandler,track) {
	//console.log("RECV SOCKET INIT WEB "+JSON.stringify(data));
	if (securityOff) {
		console.warn("WARNING: Python security is OFF")
		allemit('pyready', {data: "ready?"}); //emit cwd
	} else {
		socketHandler.socketEmitToPython('pyready', {data: "ready?"}); //check if python script is running
	}
	allon('pyok', function (data) { //if it is, go ahead and send data//authorize
		var myauth = new userPool.key();
		myauth.properties.approved = false; //set approved parameter
		myauth.properties.videoAttemptNumber = 1; //video login attempt number
		myauth.properties.passcodeAttemptNumber = 1; //passcode login attempt number
		myauth.properties.socketID = socket.id; //socket id attached to key
		myauth.properties.allowOpenCV = true; //allow opencv to happen with key
		//console.log(myauth);
		myauth.init();
		track.authkey = myauth;
		//console.log("RECV SOCKET INIT PYTHON "+JSON.stringify(data));
		//console.log("emitting to id: "+socket.id)
		socketHandler.socketEmitToID(socket.id,'webdata',{ //emit data to socket
			authkey: myauth.key,
			runtimeInformation: runtimeInformation
		});

		runtimeInformation.pythonConnected = true;
	});
}

function allemit(id, data) {
	for (var i=0; i<sockets.length; i++) {
		sockets[i].socket.emit(id,data);
	}
}

function allon(id, callback) {
	for (var i=0; i<sockets.length; i++) {
		sockets[i].socket.on(id,function() {
			callback();
		});
	}
}