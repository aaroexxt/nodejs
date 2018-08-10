//Utils dependencies
var player = require('play-sound')(opts = {});
var fetch = require('node-fetch');
var progress = require('progress-stream');
var remoteFileSize = require("remote-file-size");
var utils = require("./nodeUtils.js");
var colors = require("colors");
var fs = require('fs');

//SoundManager dependencies
var Speaker = require("speaker");
var speaker = new Speaker();
var lame = require("lame");
var pcmVolume = require("pcm-volume");
var mp3d = require('mp3-duration');
var timedStream = require('timed-stream');
var path = require('path'); 

var SCUtils = {
    localSoundcloudSettings: undefined,
    CWD: undefined,
    failedToLoadTracksFirstRun: true,
    extSocketHandler: undefined,

    /************************
    INIT: LOAD TRACKS & CACHE
    ************************/

    init: function(options) { //required: options object with properties 'soundcloudSettings','username','socketHandler', and 'cwd'
        return new Promise((resolve, reject) => {
            if (typeof options == "undefined") {
                return reject("Options was not defined in scInit");
            } else {
                if (typeof options.soundcloudSettings == "undefined") {
                    return reject("SoundcloudSettings undefined on init; did you specify them?");
                } else {
                    this.localSoundcloudSettings = options.soundcloudSettings; //shouldn't be used
                }
                if (typeof options.username == "undefined") {
                    options.username = options.soundcloudSettings.defaultUsername;
                }
                if (typeof options.socketHandler == "undefined") {
                    return reject("socketHandler not defined; can't send to sockets");
                } else {
                    this.extSocketHandler = options.socketHandler;
                }
                if (typeof options.cwd == "undefined") {
                    return reject("CWD Undefined on SC init; was it specified?");
                } else {
                    this.CWD = options.cwd;
                }
            }
            /*SC.init({
                id: options.soundcloudSettings.clientID //uid: 176787227
                //redirect_uri: "https://www.aaronbecker.tech/oAuthSoundcloud.html" //no redirect uri because it is not set in soundcloud app settings
            });*/

            //console.info(Object.keys(this))
            this.failedToLoadTracksFirstRun = true; //make sure it can run again
            this.loadUserdataCache(options.username,options.soundcloudSettings).then( data => {
                this.loadTracklist(data,options.soundcloudSettings).then( () => {
                    options.soundcloudSettings.currentUser = options.username;
                    return resolve();
                }).catch( err => {
                    return reject(err);
                }); //load tracklist with data from cache
            }).catch( err => {
                console.warn("No userdata cache found, fetching from online (err: "+err+")");
                fetch("https://api.soundcloud.com/resolve/?url="+"https://soundcloud.com/"+options.username+"/"+"&client_id="+options.soundcloudSettings.clientID+"&format=json", {timeout: options.soundcloudSettings.requestTimeout}).then( res => res.json()).then( data => { //get favorite tracks
                    this.saveUserdataCache(data,options.soundcloudSettings).then( () => {
                        console.log(colors.green("Saved SC userdata cache file"));
                    }).catch( err => {
                        console.error("Error saving SC userdata cache: "+err);
                    });

                    this.loadTracklist(data,options.soundcloudSettings).then( () => { //load tracklist with data from online
                        options.soundcloudSettings.currentUser = options.username;
                        return resolve();
                    }).catch( err => {
                        return reject(err);
                    });
                }).catch(e => {
                    return reject("Couldn't fetch userdata from online or cache; can't load tracks ;(");
                });
            })
        });
    },

    /*******************
    USERDATA CACHE: LOAD
    *******************/

    loadUserdataCache: function(username, scSettings) {
        return new Promise((resolve, reject) => {
            if (typeof username == "undefined") {
                return reject("loadUserdataCache username property not specified");
            }
            if (typeof scSettings == "undefined") {
                return reject("loadUserdataCache scSettins not specified");
            }
            var cf = scSettings.soundcloudUserdataCacheFile;
            console.log("Retreiving soundcloudUserdataCache from '"+this.CWD+"/"+cf+"-"+username+".json'");
            fs.readFile(this.CWD+"/"+cf+"-"+username+".json", function(err, data) { //include userID so caches are user specific
                if (err) {
                    return reject("No soundcloud userdata cache file found");
                } else {
                    try {
                        var scCache = JSON.parse(data);
                        //console.log(JSON.stringify(scCache))
                        if (scCache.cache) {
                            console.log("Valid soundcloud userdata cache file found; resolving");
                            return resolve(scCache.cache);
                        } else {
                            fs.unlink(this.CWD+"/"+cf+"-"+username+".json",function(err) {
                                if (err != null) {
                                    console.error("Error unlinking invalid soundcloud cache");
                                }
                            });
                            return reject("Soundcloud userdata cache is invalid (cache tag); deleting");
                        }
                    } catch(e) {
                        return reject("Soundcloud userdata cache is invalid (couldn't parse JSON)");
                    }
                }
            });
        });
    },

    /*******************
    USERDATA CACHE: SAVE
    *******************/

    saveUserdataCache: function (data, scSettings) {
        return new Promise((resolve, reject) => {
            if (typeof scSettings == "undefined") {
                return reject("saveUserdataCache scSettings not specified");
            }
            if (typeof data !== "undefined") {
                    var writeableCache = { //no expiry because userData shouldn't change
                        cache: data
                    }
                    var toWrite = JSON.stringify(writeableCache);
                    fs.writeFile(this.CWD+"/"+scSettings.soundcloudUserdataCacheFile+"-"+data.permalink+".json", toWrite, function(err) {
                        if (err != null) {
                            return reject("Error writing SC UserdataCache file: "+err);
                        } else {
                            return resolve();
                        }
                    });
            } else {
                return reject("saveCache data property not specified")
            }
        });
    },

    /**************
    TRACKLIST: LOAD
    ***************/

    loadTracklist: function (data, scSettings) {
        return new Promise((resolve, reject) => {
            if (typeof data == "undefined") { 
                return reject("Error loading tracklist: data undefined");
            }
            if (typeof scSettings == "undefined") {
                return reject("loadTracklist scSettings not specified");
            }
            console.log(colors.green("Initialized soundcloud with username: "+colors.underline(data.permalink)+" which corresponds to uid: "+colors.underline(data.id)));
            scSettings.maxLikedTracks = data.public_favorites_count;
            scSettings.userID = data.id;
            scSettings.likedTracks = [];
            scSettings.trackList = [];

            if (scSettings.tracksPerRequest > scSettings.maxTracksInRequest) {
                scSettings.tracksPerRequest = scSettings.maxTracksInRequest;
            }
            var requiredRequestTimes = Math.ceil(scSettings.maxLikedTracks/scSettings.tracksPerRequest); //how many requests?
            if (requiredRequestTimes > scSettings.requestConstraint) { //constrain it
                requiredRequestTimes = scSettings.requestConstraint;
            }
            var tracksToLoad = (scSettings.maxLikedTracks/scSettings.tracksPerRequest); //evaluate
            if (tracksToLoad > scSettings.requestConstraint) {
                while (tracksToLoad>scSettings.requestConstraint) {
                    tracksToLoad-=1;
                }
            }
            tracksToLoad*=scSettings.tracksPerRequest;
            tracksToLoad = Math.round(tracksToLoad);
            var requestCounter = 0;
            console.log("Making "+requiredRequestTimes+" request(s) for trackdata; results in "+tracksToLoad+" tracks being loaded");
            for (var j=0; j<requiredRequestTimes; j++) {
                setTimeout(function(){
                    fetch("https://api.soundcloud.com/users/"+scSettings.userID+"/favorites.json?client_id="+scSettings.clientID+"&offset="+(scSettings.tracksPerRequest*j)+"&limit="+scSettings.tracksPerRequest+"&format=json", {timeout: scSettings.requestTimeout}).then( res => res.json()).then( tracks => { //get favorite tracks
                        //console.log("TRACKS "+JSON.stringify(tracks));
                        for (var i=0; i<tracks.length; i++) {
                            scSettings.likedTracks.push({ //extract track info
                                title: tracks[i].title,
                                index: i,
                                id: tracks[i].id,
                                author: tracks[i].user.username,
                                duration: tracks[i].duration,
                                playing: false,
                                artwork: {
                                    artworkUrl: (tracks[i].artwork_url !== null && typeof tracks[i].artwork_url !== "undefined") ? tracks[i].artwork_url.substring(0,tracks[i].artwork_url.indexOf("large"))+"t500x500"+tracks[i].artwork_url.substring(tracks[i].artwork_url.indexOf("large")+"large".length) : tracks[i].artwork_url,
                                    waveformUrl: tracks[i].waveform_url
                                }
                            });
                            scSettings.trackList.push(tracks[i].title);
                        }

                        //console.info(JSON.stringify(scSettings));
                        requestCounter++; //increment the counter
                        
                        if (scSettings.trackList.length >= tracksToLoad || requestCounter >= requiredRequestTimes) { //does loaded tracklist length equal tracks to load (equates for partial requests)
                            console.log(colors.green("Processed "+colors.underline(scSettings.likedTracks.length)+" tracks for soundcloud"));
                            scSettings.tracksFromCache = false;
                            SCUtils.extSocketHandler.socketEmitToWeb("POST", {action: "serverLoadedTracks", trackList: scSettings.trackList, likedTracks: scSettings.trackList, hasTracks: true}); //send serverloadedtracks
                            console.log("Saving SC cache...");
                            SCUtils.saveTrackCache(scSettings.likedTracks, scSettings.userID, scSettings).then( () => {
                                console.log(colors.green("Saved track cache; saving tracks"));
                                SCUtils.saveAllTracks(scSettings).then( () => {
                                    console.log(colors.green("Loaded all SC tracks"));
                                    return resolve();
                                }).catch( err => {
                                    return reject("Error saving tracks: "+err);
                                });
                            }).catch( err => {
                                return reject("Error saving cache: "+err);
                            });
                        }
                    }).catch( e => {
                        console.warn("Failed to get track from trackRequest (e: "+e+"); going to cache");
                        SCUtils.failedToLoadTracks(e, scSettings).then( () => {
                            return resolve();
                        }).catch( err => {
                            return reject(err);
                        }); //failed to load the tracks
                    });
                },scSettings.delayBetweenTracklistRequests*j);
            }
        })
    },

    /*******************
    TRACKLISTCACHE: SAVE
    *******************/

    saveTrackCache: function (likedTracks,userID,scSettings) { //save cache
        return new Promise((resolve, reject) => {
            if (typeof scSettings == "undefined") {
                return reject("saveTrackCache scSettings not specified");
            }
            if (typeof userID !== "undefined") {
                if (typeof likedTracks !== "undefined" && likedTracks.length > 0) {
                    var expiry = new Date().getTime()+scSettings.soundcloudCacheExpiryTime;
                    var writeableCache = {
                        expiryTime: expiry,
                        cache: likedTracks
                    }
                    var toWrite = JSON.stringify(writeableCache);
                    fs.writeFile(this.CWD+"/"+scSettings.soundcloudTrackCacheFile+"-"+userID+".json", toWrite, function(err) {
                        if (err != null) {
                            return reject("Error writing SC TrackCache file: "+err);
                        } else {
                            return resolve();
                        }
                    });
                } else {
                    return reject("likedTracks undefined or no tracks");
                }
            } else {
                return reject("saveCache userID property not specified")
            }
        });
    },

    /*******************
    TRACKLISTCACHE: LOAD
    *******************/

    loadTrackCache: function (userID, scSettings) { // load cache
        return new Promise((resolve, reject) => {
            if (typeof userID == "undefined") {
                return reject("loadTrackCache userID property not specified");
            }
            if (typeof scSettings == "undefined") {
                return reject("loadTrackCache scSettings not specified");
            }
            var cf = scSettings.soundcloudTrackCacheFile;
            console.log("Retreiving soundcloudCache from '"+cf+"-"+userID+".json'");
            fs.readFile(this.CWD+"/"+cf+"-"+userID+".json", function(err, data) { //include userID so caches are user specific
                if (err) {
                    return reject("No soundcloud cache file found");
                } else {
                    try {
                        var scCache = JSON.parse(data);
                    } catch(e) {
                        return reject("Soundcloud track cache is invalid (couldn't parse JSON)");
                    }
                    //console.log(JSON.stringify(scCache))
                    if (scCache.expiryTime && scCache.cache) {
                        var d = new Date().getTime();
                        if (d-scCache.expiryTime < scSettings.soundcloudCacheExpiryTime) { //is cache ok?
                            console.log("Valid soundcloud cache file found; resolving");
                            return resolve(scCache);
                        } else { //aww it's expired
                            fs.unlink(this.CWD+"/"+cf+"-"+userID+".json",function(err) {
                                if (err != null) {
                                    console.error("Error unlinking expired soundcloud cache");
                                }
                            });
                            return reject("Soundcloud cache is expired; deleting");
                        }
                    } else {
                        fs.unlink(this.CWD+"/"+cf+"-"+userID+".json",function(err) {
                            if (err != null) {
                                console.error("Error unlinking invalid soundcloud cache");
                            }
                        });
                        return reject("Soundcloud track cache is invalid (missing expiryTime and/or cache tags); deleting");
                    }
                }
            });
        });
    },

    /**************************************
    FAILED TO LOAD TRACKS: FETCH FROM CACHE
    **************************************/

    failedToLoadTracks: function (e, scSettings) {
        return new Promise((resolve, reject) => {
            if (this.failedToLoadTracksFirstRun == false) { //so it only can run once
                return reject("FailedToLoadTracks already called");
            }
            if (typeof scSettings == "undefined") {
                return reject("failedToLoadTracks scSettings not specified");
            }
            this.failedToLoadTracksFirstRun = false;
            //console.info("Error getting soundcloud tracks: "+JSON.stringify(e));
            console.log("Getting tracks from cache");
            this.extSocketHandler.socketEmitToWeb("POST", {action: "serverLoadingCachedTracks"}); //send serverloadedtracks
            this.loadTrackCache(scSettings.userID, scSettings).then( cacheObject => {
                var cachelen = cacheObject.cache.length;
                var cache = cacheObject.cache;
                var cacheExpiry = cacheObject.expiryTime;
                console.log("Cache expires at dT: "+cacheExpiry);

                if (typeof cache == "undefined" || cachelen == 0) {
                    return reject("TrackCache is undefined or has no tracks");
                    SCUtils.extSocketHandler.socketEmitToWeb("POST", {action: "serverNoTrackCache"}); //send serverloadedtracks
                } else {
                    scSettings.tracksFromCache = true;
                    scSettings.likedTracks = [];
                    scSettings.trackList = [];
                    for (var i=0; i<cache.length; i++) {
                        scSettings.likedTracks.push(cache[i]);
                        scSettings.trackList.push(cache[i].title);
                    }
                    console.log("Attempting to save tracks; will probably fail from no connection");
                    this.saveAllTracks(scSettings).then( () => {
                        console.log(colors.green("Loaded all SC tracks"));
                        return resolve();
                    }).catch( err => {
                        return reject("Expected error saving tracks: "+err);
                    });
                    SCUtils.extSocketHandler.socketEmitToWeb("POST", {action: "serverLoadedTracks", trackList: scSettings.trackList, likedTracks: scSettings.trackList, hasTracks: true}); //send serverloadedtracks
                }
            }).catch( error => {
                SCUtils.extSocketHandler.socketEmitToWeb("POST", {action: "serverNoTrackCache"}); //send serverloadedtracks
                return reject("Server has no track cache, no music playing possible (err: "+error+")");
            });
        });
    },

    /******************************
    SAVE TRACKS: SAVE TO LOCAL DISK
    ******************************/

    saveAllTracks: function (scSettings) { //save tracks
        return new Promise((resolve, reject) => {
            if (typeof scSettings == "undefined") {
                return reject("saveAllTracks scSettings not specified");
            } else {
                var likedTracks = scSettings.likedTracks;
            }
            if (typeof likedTracks !== "undefined" && likedTracks.length > 0) {

                var tracksToLoad = likedTracks.length;
                var tracksLoaded = 0;
                console.log("Have to save: "+tracksToLoad+" tracks");

                //function does not execute yet, check below
                function loadTrackIndex(trackIndex) {
                    if (!likedTracks[trackIndex].id || !likedTracks[trackIndex].title) {
                        return reject("TrackObject is invalid")
                    }
                    var trackID = likedTracks[trackIndex].id;
                    SCUtils.extSocketHandler.socketEmitToWeb("POST", {action: "serverLoadingTracksUpdate", track: likedTracks[trackIndex].title, percent: ((tracksLoaded+1)/tracksToLoad)*100});
                    //console.log("Fetching SC track '"+likedTracks[trackIndex].title+"'");

                    var unfinTrackPath = (SCUtils.CWD+"/"+scSettings.soundcloudTrackCacheDirectory+"/"+"track-"+trackID+"-UNFINISHED.mp3");
                    var trackPath = (SCUtils.CWD+"/"+scSettings.soundcloudTrackCacheDirectory+"/"+"track-"+trackID+".mp3");
                    var pTitle = (likedTracks[trackIndex].title.length > 20) ? likedTracks[trackIndex].title.substring(0,20) : likedTracks[trackIndex].title;
                    var lpTitle = (likedTracks[trackIndex].title.length > 35) ? likedTracks[trackIndex].title.substring(0,35) : likedTracks[trackIndex].title;
                    //console.log("Checking if track exists at path "+trackPath);
                    fs.readFile(trackPath, (err, data) => {
                        if (err) {
                            //console.log("Track does not exist, downloading at path "+unfinTrackPath);
                            fetch("http://api.soundcloud.com/tracks/"+String(trackID)+"/stream?client_id="+scSettings.clientID, {timeout: scSettings.requestTimeout}).then(function(response){
                                //console.log("SC RESPONSE URL: "+response.url+", HEADERS: "+JSON.stringify(response.headers.entries()));
                                remoteFileSize(response.url, function(err, size) { //get size of file
                                    if (err) {
                                        if (err.toString().indexOf("401") > 0) {
                                            console.warn("A 401 error was recieved on attempt to get size; denied. Can't fetch track");
                                            tracksLoaded++;
                                            loadTrackIndex(tracksLoaded);
                                        } else {
                                            return reject("Error getting SC file size: "+err);
                                        }
                                    } else {
                                        //console.log("Got track URL and size. SIZE: "+size);
                                        return new Promise((sresolve, sreject) => {
                                            //console.log("writing to path: "+unfinTrackPath);
                                            const dest = fs.createWriteStream(unfinTrackPath); //write to unfinished track path first
                                            var pBar = new utils.progressBar({
                                                startPercent: 0,
                                                task: "Downloading '"+pTitle+"'",
                                                showETA: true
                                            });
                                            var str = progress({
                                                time: 500,
                                                length: size
                                            }, progress => {
                                                //console.log("Percentage: "+progress.percentage+", ETA: "+progress.eta+" (for trackID "+trackID+")");
                                                pBar.update(progress.percentage/100,utils.formatHHMMSS(progress.eta));
                                            });
                                            response.body.pipe(str).pipe(dest);
                                            response.body.on('error', err => {
                                                return sreject(err);
                                            });
                                            dest.on('finish', () => {
                                                //console.log("Renaming to finished track")
                                                fs.rename(unfinTrackPath, trackPath, err => {
                                                    if (err) {
                                                        return sreject("Error renaming track");
                                                    } else {
                                                        return sresolve();
                                                    }
                                                });
                                            });
                                            dest.on('error', err => {
                                                if (err.toString().indexOf("401") > 0) {
                                                    console.warn("401 forbidden gotten; can't download");
                                                    tracksLoaded++;
                                                    loadTrackIndex(tracksLoaded);
                                                } else {
                                                    return sreject(err);
                                                }
                                            });
                                        }).then( () => {
                                            tracksLoaded++;
                                            console.log("Track '"+lpTitle+"' written successfully, overall prog: "+(tracksLoaded/tracksToLoad)*100);
                                            if (tracksLoaded == tracksToLoad) {
                                                console.log("Done loading tracks, resolving");
                                                return resolve();
                                            } else {
                                                loadTrackIndex(tracksLoaded);
                                            }
                                        }).catch( err => {
                                            console.error("Error writing SC track: "+err);
                                        })
                                    }
                                })
                            }).catch(e => {
                                return reject("Error fetching track stream URL");
                            });
                        } else {
                            tracksLoaded++;
                            console.log("Track '"+lpTitle+"' found already, prog: "+(tracksLoaded/tracksToLoad)*100);
                            if (tracksLoaded == tracksToLoad) {
                                console.log("Done loading tracks, resolving");
                                return resolve();
                            } else {
                                loadTrackIndex(tracksLoaded);
                            }
                        }
                    });
                }

                console.log("Checking directory: "+this.CWD+"/"+scSettings.soundcloudTrackCacheDirectory+" for unfinished tracks");
                var unfinishedTracks = [];
                fs.readdir(this.CWD+"/"+scSettings.soundcloudTrackCacheDirectory, (err, files) => {
                    if (err) {
                        return reject("Error checking cache directory for unfinished tracks");
                    } else {
                        for (var i=0; i<files.length; i++) {
                            if (files[i].indexOf("UNFINISHED") > -1) {
                                unfinishedTracks.push(files[i]);

                                let path = this.CWD+"/"+scSettings.soundcloudTrackCacheDirectory+"/"+files[i];
                                fs.unlink(path, err => {
                                    if (err) {
                                        console.error("Error unlinking unfinished track at path "+path);
                                    }
                                })
                            }
                        }
                        if (unfinishedTracks.length > 0) {
                            console.log("Found "+unfinishedTracks.length+" unfinished tracks, deleted");
                        }
                        loadTrackIndex(0); //start track loading (recursive)
                    }
                });

            } else {
                return reject("likedTracks undefined or no tracks");
            }
        });
    },

    /*******************************
    SAVE TRACKS: SAVE A SINGLE TRACK
    *******************************/

    saveTrack: function (trackObject, scSettings) {
        return new Promise((resolve, reject) => {
            if (typeof scSettings == "undefined") {
                return reject("saveTrack scSettings not specified");
            }
            if (!trackObject.id || !trackObject.title) {
                return reject("saveTrack TrackObject is invalid")
            }
            var trackID = trackObject.id;
            console.log("Fetching SC track '"+trackObject.title+"'");

            //todo delete unfinished tracks

            var unfinTrackPath = (this.CWD+"/"+scSettings.soundcloudTrackCacheDirectory+"/"+"track-"+trackID+"-UNFINISHED.mp3");
            var trackPath = (this.CWD+"/"+scSettings.soundcloudTrackCacheDirectory+"/"+"track-"+trackID+".mp3");
            //console.log("Checking if track exists at path "+trackPath);
            fs.readFile(trackPath, (err, data) => {
                if (err) {
                    console.log("Track does not exist, downloading at path "+unfinTrackPath);
                    fetch("http://api.soundcloud.com/tracks/"+String(trackID)+"/stream?client_id="+scSettings.clientID, {timeout: scSettings.requestTimeout}).then(function(response){
                        //console.log("SC RESPONSE URL: "+response.url+", HEADERS: "+JSON.stringify(response.headers.entries()));
                        remoteFileSize(response.url, function(err, size) { //get size of file
                            if (err) {
                                return reject("Error getting SC file size: "+err);
                            } else {
                                console.log("Got track URL and size. SIZE: "+size);
                                return new Promise((sresolve, sreject) => {
                                    console.log("writing to path: "+unfinTrackPath);
                                    const dest = fs.createWriteStream(unfinTrackPath); //write to unfinished track path first
                                    var pTitle = (trackObject.title.length > 15) ? trackObject.title.substring(0,15) : trackObject.title;
                                    var pBar = new utils.progressBar({
                                        startPercent: 0,
                                        task: "Downloading '"+pTitle+"'",
                                        showETA: true
                                    });
                                    var str = progress({
                                        time: 500,
                                        length: size
                                    }, progress => {
                                        //console.log("Percentage: "+progress.percentage+", ETA: "+progress.eta+" (for trackID "+trackID+")");
                                        pBar.update(progress.percentage/100,utils.formatHHMMSS(progress.eta));
                                    });
                                    response.body.pipe(str).pipe(dest);
                                    response.body.on('error', err => {
                                        return sreject(err);
                                    });
                                    dest.on('finish', () => {
                                        console.log(""); //clear progress bar
                                        console.log("Renaming to finished track")
                                        fs.rename(unfinTrackPath, trackPath, err => {
                                            if (err) {
                                                return sreject("Error renaming track");
                                            } else {
                                                return sresolve();
                                            }
                                        });
                                    });
                                    dest.on('error', err => {
                                        return sreject(err);
                                    });
                                }).then( () => {
                                    console.log("Track '"+trackObject.title+"' written successfully, resolving");
                                    return resolve();
                                }).catch( err => {
                                    console.error("Error writing SC track: "+err);
                                });
                            }
                        });
                    }).catch(e => {
                        return reject("Error fetching track stream URL");
                    });
                } else {
                    console.log("Track '"+trackObject.title+"' found already, prog: "+(tracksLoaded/tracksToLoad)*100);
                    return resolve();
                }
            });
        });
    }

    /*
    var audio = player.play('octocat.mp3', function(err){
        if (err && !err.killed) throw err
        if (err.killed) console.log("Killed audio track")
    })
    setTimeout( () => {
        audio.kill();
    },10000);
    */
}

var SCSoundManager = {
    playingTrack: false,
    currentVolume: 50,

    MINVOLUME: 0, //pcm constants, shouldn't be changed for any reason
    MAXVOLUME: 1.5,

    currentPlayingTrack: {},
    currentPlayingTrackDuration: 0,
    currentPlayingTrackPosition: 0,

    playerObject: {
        play: function(){},
        stop: function(){}
    },
    init: () => {
        return new Promise((resolve, reject) => {
            this.currentPlayingTrack = SCUtils.localSoundcloudSettings.likedTracks[0]; //start with first track
            SCSoundManager.currentVolume = SCUtils.localSoundcloudSettings.defaultVolume;
            SCSoundManager.playTrack(this.currentPlayingTrack);
            resolve();
        });
    },
    processClientEvent: function(ev) {
        if (ev && ev.type) {
            switch (ev.type) {
                case "playPause":
                    if (SCSoundManager.playingTrack) {
                        SCSoundManager.playerObject.stop();
                        SCSoundManager.playingTrack = false;
                    } else {
                        SCSoundManager.playerObject.play();
                        SCSoundManager.playingTrack = true;
                    }
                    break;
                case "volumeUp":
                    break;
                case "volumeDown":
                    break;
                case "trackForward":
                    break;
                case "trackBackward":
                    break;
                case "clientLocalTrackFinished":
                    break;
                case "clientPlayTrack":
                    break;
                case "changeTrackLoopState":
                    SCUtils.localSoundcloudSettings.nextTrackLoop = !SCUtils.localSoundcloudSettings.nextTrackLoop;
                    break;
                case "changeTrackShuffleState":
                    SCUtils.localSoundcloudSettings.nextTrackShuffle = !SCUtils.localSoundcloudSettings.nextTrackShuffle;
                    break;
                default:
                    console.error("unknown event "+ev+" passed into SCProcCliEvent");
                    break;
            }
        } else {
            console.error("SCSoundmanager proc cliEv called with no event or invalid");
        }
    },
        /*console.log("playing id: "+track.id); 
        SC.stream('/tracks/' + track.id).then(function(player) {
            globals.music.soundManager.playerObject.pause(); //pause previous
            globals.music.soundManager.playerObject = player;
            globals.music.soundManager.playerObject.play();
            globals.music.soundManager.playingTrack = true;
            ID("music_trackArt").src = (!track.artwork.artworkUrl) ? SCUtils.localSoundcloudSettings.noArtworkUrl : track.artwork.artworkUrl;
            ID("music_waveformArt").src = track.artwork.waveformUrl;
            ID("music_trackTitle").innerHTML = track.title;
            ID("music_trackAuthor").innerHTML = "By: "+track.author;
            globals.music.soundManager.currentPlayingTrack = track;
        }).catch(function(){
            console.error("Error playing track with id ("+track.id+"): ",arguments);
            ID("music_trackArt").src = "images/errorLoadingTrack.png";
        });
    },*/
    playTrackServer: function(track) {
        ID("music_trackArt").src = (!track.artwork.artworkUrl) ? SCUtils.localSoundcloudSettings.noArtworkUrl : track.artwork.artworkUrl;
        ID("music_waveformArt").src = track.artwork.waveformUrl;
        ID("music_trackTitle").innerHTML = track.title;
        ID("music_trackAuthor").innerHTML = "By: "+track.author;
    },
    
    getPercent: function() {
        return Math.round((SCSoundManager.playerObject.currentTime()/SCSoundManager.playerObject.getDuration())*100);
    },
    startTrackManager: function() {
        clearInterval(SCUtils.localSoundcloudSettings.trackUpdateInterval);
        SCUtils.localSoundcloudSettings.trackUpdateInterval = setInterval(function() {
            var isDone = ((SCSoundManager.playerObject.currentTime()/SCSoundManager.playerObject.getDuration()) >= 0.999);
            if (isDone) {
                if (SCUtils.localSoundcloudSettings.nextTrackLoop) { //loop?
                    SCSoundManager.playerObject.seek(0); //loop the track
                } else {
                    SCSoundManager.forwardTrack(); //nah just forward
                }
            }
        },200)
    },
    volUp: function() {
        if (SCSoundManager.currentVolume+SCUtils.localSoundcloudSettings.volStep <= 100) {
            SCSoundManager.currentVolume+=SCUtils.localSoundcloudSettings.volStep;
            SCSoundManager.setPlayerVolume(SCSoundManager.currentVolume);
        }
    },
    volDown: function() {
        if (SCSoundManager.currentVolume-SCUtils.localSoundcloudSettings.volStep > 0) {
            SCSoundManager.currentVolume-=SCUtils.localSoundcloudSettings.volStep;
            SCSoundManager.setPlayerVolume(SCSoundManager.currentVolume);
        }
    },
    backTrack: function() { //always goes back 1
        var ind = SCSoundManager.currentPlayingTrack.index-1;
        if (ind < 0) {
            ind = SCUtils.localSoundcloudSettings.likedTracks.length-1; //go to last track
        }
        SCSoundManager.playTrack(SCUtils.localSoundcloudSettings.likedTracks[ind]);
    },
    forwardTrack: function() { //can go forward one or shuffle to get to next track
        if (SCUtils.localSoundcloudSettings.nextTrackShuffle) {
            var ind = Math.round(Math.random()*SCUtils.localSoundcloudSettings.likedTracks.length);
            if (ind == SCSoundManager.currentPlayingTrack.index) { //is track so add one
                ind++;
                if (ind > SCUtils.localSoundcloudSettings.likedTracks.length) { //lol very random chance that it wrapped over
                    ind = 0;
                }
            }
            SCSoundManager.playTrack(SCUtils.localSoundcloudSettings.likedTracks[ind]);
        } else {
            var ind = SCSoundManager.currentPlayingTrack.index+1;
            if (ind > SCUtils.localSoundcloudSettings.likedTracks.length) {
                ind = 0; //go to first track
            }
            SCSoundManager.playTrack(SCUtils.localSoundcloudSettings.likedTracks[ind]);
        }
    },
    setPlayerVolume: function(vol) {
        if (SCSoundManager.currentVolume == null || typeof SCSoundManager.currentVolume == "undefined") {
            SCSoundManager.currentVolume = SCUtils.localSoundcloudSettings.defaultVolume;
        }
        if (vol < 0) {
            vol = 0;
        }
        if (vol > 100) {
            vol = 100;
        }
        var nMap = function (number, in_min, in_max, out_min, out_max) {
            return (number - in_min) * (out_max - out_min) / (in_max - in_min) + out_min;
        }

        var clamp = function(number, min, max) {
            return Math.min(Math.max(number, min), max);
        }

        SCSoundManager.currentVolume = clamp(SCSoundManager.currentVolume, 0, 100);
        SCSoundManager.pcmVolumeAdjust.setVolume(nMap(SCSoundManager.currentVolume, 0, 100, SCSoundManager.MINVOLUME, SCSoundManager.MAXVOLUME)); //map the volume
    },
    playTrack: function(trackObject) {
        var trackPath = SCUtils.CWD+"/"+SCUtils.localSoundcloudSettings.soundcloudTrackCacheDirectory+"/track-"+trackObject.id+".mp3";
        console.log("Playing track from path: "+trackPath);
        fs.stat(trackPath, function(err, stat) {
            if (err == null) {
                //console.log("file exists, ok w/stat "+JSON.stringify(stat));

                mp3d(trackPath, (err, duration) => {
                    if (err) {
                        return console.error("error getting duration of mp3: "+err.message);
                    } else {
                        console.log("Track duration in seconds long: "+duration);
                        SCSoundManager.currentPlayingTrackDuration = duration;
                        SCSoundManager.currentPlayingTrackPosition = 0;

                        var ts = new timedStream();

                        var readable = fs.createReadStream(trackPath); //create the read path
                        var decoder = new lame.Decoder({
                            channels: 2,
                            bitDepth: 16,
                            sampleRate: 44100,
                            bitRate: 128,
                            outSampleRate: 22050,
                            mode: lame.STEREO
                        });
                        var volumeTweak = new pcmVolume();
                        SCSoundManager.pcmVolumeAdjust = volumeTweak;


                        SCSoundManager.setPlayerVolume(SCSoundManager.currentVolume);

                        var spk = new Speaker();
                        spk.on('error', err => console.error('error on speaker, ', err));

                        readable.pipe(ts)
                            .pipe(decoder)
                            .pipe(volumeTweak)
                            .pipe(spk)
                            .on('close', () => { console.log("SPK CLOSE!"); this.stop(); }); //pipe stream to MP3 decoder
                        
                        function resume() {
                            ts.resumeStream();
                            ts.pipe(decoder);
                            //volumeTweak.pipe(spk); //pipe adjusted volume tweak stream to speaker (which will play it)
                            //decoder.pipe(volumeTweak); //pipe decoder to volumeTweaker to change volume
                            
                        }

                        function pause() {
                            ts.pauseStream();
                            ts.unpipe(decoder);
                        }

                        var seekBuffer = 0;
                        volumeTweak.on('data', data => {
                            seekBuffer+=data.length;
                            console.log("sbl: "+seekBuffer);
                        });

                        setTimeout( () => {
                            console.log("PAUSING");
                            pause();
                            setTimeout( () => {
                                console.log("RESUMING");
                                resume();
                            },5000);
                        },5000);

                        var trackSniffTimeout = 10;
                        var trackSniffInterval = setInterval( () => {
                            SCSoundManager.currentPlayingTrackPosition+=trackSniffTimeout/1000;
                            if (SCSoundManager.currentPlayingTrackPosition > SCSoundManager.currentPlayingTrackDuration) {
                                console.info("TRACK HAS ENDED!");
                            }
                        },10);
                    }
                });
            } else {
                return console.error("File doesn't exist")
            }
        })
    }
}

exports.SCUtils = SCUtils;
exports.SCSoundManager = SCSoundManager;