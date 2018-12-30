/*
* soundcloud.js by Aaron Becker
* A wrapper around the web soundcloud api that is capable of caching tracks & userdata locally
*
* Dedicated to Marc Perkel
*
* Copyright (C) 2018, Aaron Becker <aaron.becker.developer@gmail.com>
*/

//Utils dependencies
const fetch = require('node-fetch');
const progress = require('progress-stream');
const remoteFileSize = require("remote-file-size");
const utils = require("./utils.js");
const colors = require("colors");
const fs = require('fs');

//SoundManager dependencies
const Speaker = require("speaker");
const lame = require("lame");
const pcmVolume = require("pcm-volume");
const mp3d = require('mp3-duration');
const timedStream = require('timed-stream');
const path = require('path'); 

var SCUtils = {
    localSoundcloudSettings: undefined,
    CWD: undefined,
    failedToLoadTracksFirstRun: true,
    debugMode: false,
    track401Offset: 0, //offset to keep track of tracks that load as 401 and to subtract length

    /************************
    INIT: LOAD TRACKS & CACHE
    ************************/

    init: function(options) { //required: options object with properties 'soundcloudSettings','username' and 'cwd'
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
                if (typeof options.cwd == "undefined") {
                    return reject("CWD Undefined on SC init; was it specified?");
                } else {
                    this.CWD = options.cwd;
                }
            }

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
            console.log("Retreiving soundcloudUserdataCache from '"+path.join(SCUtils.CWD,(cf+"-"+username+".json'")));
            fs.readFile(path.join(SCUtils.CWD,(cf+"-"+username+".json")), (err, data) => { //include userID so caches are user specific
                if (err) {
                    console.error("No trackCache file found :(")
                    return reject("No soundcloud userdata cache file found");
                } else {
                    try {
                        var scCache = JSON.parse(data);
                        //console.log(JSON.stringify(scCache))
                        if (scCache.cache) {
                            console.log("Valid soundcloud userdata cache file found; resolving");
                            return resolve(scCache.cache);
                        } else {
                            fs.unlink(path.join(SCUtils.CWD,(cf+"-"+username+".json")),function(err) {
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
                fs.writeFile(path.join(SCUtils.CWD,(scSettings.soundcloudUserdataCacheFile+"-"+data.permalink+".json")), toWrite, function(err) {
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
            if (typeof data.permalink == "undefined" || typeof data.id == "undefined") {
                return reject("Couldn't find user");
            }
            console.log(colors.green("Initialized soundcloud with username: "+colors.underline(data.permalink)+" which corresponds to uid: "+colors.underline(data.id)));
            scSettings.maxLikedTracks = data.public_favorites_count;
            scSettings.userID = data.id;
            scSettings.likedTracks = [];
            scSettings.trackList = [];
            scSettings.tracksToLoad = -1;
            scSettings.tracksLoaded = 0;

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
            if (requiredRequestTimes == 0) {
                return resolve();
            }
            for (var j=0; j<requiredRequestTimes; j++) {
                fetch("https://api.soundcloud.com/users/"+scSettings.userID+"/favorites.json?client_id="+scSettings.clientID+"&offset="+(scSettings.tracksPerRequest*j)+"&limit="+scSettings.tracksPerRequest+"&format=json", {timeout: scSettings.requestTimeout}).then( res => res.json()).then( tracks => { //get favorite tracks
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

                    requestCounter++; //increment the counter
                    //console.log("REQUEST_COUNTER: "+requestCounter+", likedtracks ",scSettings.likedTracks);
                    
                    if (scSettings.trackList.length >= tracksToLoad || requestCounter >= requiredRequestTimes) { //does loaded tracklist length equal tracks to load (equates for partial requests)
                        scSettings.tracksToLoad = scSettings.trackList.length; //didn't load all so change len
                        console.log(colors.green("Processed "+colors.underline(scSettings.likedTracks.length)+" tracks for soundcloud"));
                        scSettings.tracksFromCache = false;
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
                    if (SCUtils.failedToLoadTracksFirstRun) {
                        SCUtils.failedToLoadTracks(e, scSettings).then( () => {
                            return resolve();
                        }).catch( err => {
                            return reject(err);
                        }); //failed to load the tracks
                    }
                });
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
                    fs.writeFile(path.join(SCUtils.CWD,(scSettings.soundcloudTrackCacheFile+"-"+userID+".json")), toWrite, function(err) {
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
            fs.readFile(path.join(SCUtils.CWD,(cf+"-"+userID+".json")), function(err, data) { //include userID so caches are user specific
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
                            fs.unlink(path.join(SCUtils.CWD,(cf+"-"+userID+".json")),function(err) {
                                if (err != null) {
                                    console.error("Error unlinking expired soundcloud cache");
                                }
                            });
                            return reject("Soundcloud cache is expired; deleting");
                        }
                    } else {
                        fs.unlink(path.join(SCUtils.CWD,(cf+"-"+userID+".json")),function(err) {
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
                console.warn("FailedToLoadTracks already called on init");
                //return resolve();
            }
            if (typeof scSettings == "undefined") {
                return reject("failedToLoadTracks scSettings not specified");
            }
            this.failedToLoadTracksFirstRun = false;
            //console.info("Error getting soundcloud tracks: "+JSON.stringify(e));
            console.log("Getting tracks from cache");
            this.loadTrackCache(scSettings.userID, scSettings).then( cacheObject => {
                var cachelen = cacheObject.cache.length;
                var cache = cacheObject.cache;
                var cacheExpiry = cacheObject.expiryTime;
                console.log("Cache expires at dT: "+cacheExpiry);

                if (typeof cache == "undefined" || cachelen == 0) {
                    return reject("TrackCache is undefined or has no tracks");
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
                }
            }).catch( error => {
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
                SCUtils.track401Offset = 0; //set 401 offset

                var tracksToLoad = likedTracks.length;
                var tracksLoaded = 0;
                console.log("Have to save: "+tracksToLoad+" tracks+artwork+waveforms");

                //function does not execute yet, check below
                function loadTrackIndex(trackIndex) {
                    scSettings.tracksToLoad = tracksToLoad;
                    scSettings.tracksLoaded = tracksLoaded;

                    if (SCUtils.debugMode) {
                        console.log("Fetching SC track '"+likedTracks[trackIndex].title+"'");
                    }

                    SCUtils.saveTrack(likedTracks[trackIndex], scSettings) //using way more efficient method that takes advantage of the builtin saveTrack function
                    .then( () => {
                        tracksLoaded++;
                        if (tracksLoaded == tracksToLoad) {
                            console.log("Done loading tracks, resolving");
                            return resolve();
                        } else {
                            console.log("sc load progress: "+String(Math.round(tracksLoaded/tracksToLoad*10000)/100)+"%")
                            loadTrackIndex(tracksLoaded);
                        }
                    })
                    .catch( err => {
                        return reject(err);
                    })
                }

                var trackFolderPath = path.join(SCUtils.CWD,scSettings.soundcloudTrackCacheDirectory);
                var artFolderPath = path.join(SCUtils.CWD,scSettings.soundcloudArtworkCacheDirectory);
                var waveFolderPath = path.join(SCUtils.CWD,scSettings.soundcloudWaveformCacheDirectory);

                if (SCUtils.debugMode) {
                    console.log("Checking directories for unf tracks: "+trackFolderPath+", "+artFolderPath+", "+waveFolderPath);
                }
                var unfinishedTracks = [];
                var unfinishedArtwork = [];
                var unfinishedWaveform = [];

                var checkedTracksOnce = false;
                var checkedArtworkOnce = false;
                var checkedWaveformOnce = false;

                function checkUnfinishedTracks() {
                    fs.readdir(trackFolderPath, (err, files) => {
                        if (err) {
                            if (checkedTracksOnce) {
                                return reject("Error checking cache directory for unfinished tracks (folder not found on second attempt)");
                            } else { //create the dir because it is missing
                                checkedTracksOnce = true;
                                fs.mkdir(trackFolderPath, e => {
                                    if (e) {
                                        return reject("Error creating folder at path: "+trackFolderPath+", e="+JSON.stringify(e));
                                    } else {
                                        checkUnfinishedTracks();
                                    }
                                })
                            }
                        } else {
                            for (var i=0; i<files.length; i++) {
                                if (files[i].indexOf("UNFINISHED") > -1) {
                                    unfinishedTracks.push(files[i]);

                                    let unlinkPath = path.join(SCUtils.CWD,scSettings.soundcloudTrackCacheDirectory,files[i]);
                                    fs.unlink(unlinkPath, err => {
                                        if (err) {
                                            console.error("Error unlinking unfinished track at path "+path);
                                        }
                                    })
                                }
                            }
                            if (unfinishedTracks.length > 0) {
                                console.log("Found "+unfinishedTracks.length+" unfinished tracks, deleted");
                            }
                            
                        }
                    });

                    fs.readdir(artFolderPath, (err, files) => {
                        if (err) {
                            if (checkedArtworkOnce) {
                                return reject("Error checking cache directory for unfinished artwork (folder not found on second attempt)");
                            } else { //create the dir because it is missing
                                checkedArtworkOnce = true;
                                fs.mkdir(artFolderPath, e => {
                                    if (e) {
                                        return reject("Error creating artwork folder at path: "+artFolderPath+", e="+JSON.stringify(e));
                                    } else {
                                        checkUnfinishedTracks();
                                    }
                                })
                            }
                        } else {
                            for (var i=0; i<files.length; i++) {
                                if (files[i].indexOf("UNFINISHED") > -1) {
                                    unfinishedArtwork.push(files[i]);

                                    let unlinkPath = path.join(SCUtils.CWD,scSettings.soundcloudArtworkCacheDirectory,files[i]);
                                    fs.unlink(unlinkPath, err => {
                                        if (err) {
                                            console.error("Error unlinking unfinished art at path "+path);
                                        }
                                    })
                                }
                            }
                            if (unfinishedTracks.length > 0) {
                                console.log("Found "+unfinishedTracks.length+" unfinished art, deleted");
                            }
                            
                        }
                    });
                    fs.readdir(waveFolderPath, (err, files) => {
                        if (err) {
                            if (checkedWaveformOnce) {
                                return reject("Error checking cache directory for unfinished waveform (folder not found on second attempt)");
                            } else { //create the dir because it is missing
                                checkedWaveformOnce = true;
                                fs.mkdir(waveFolderPath, e => {
                                    if (e) {
                                        return reject("Error creating folder at path: "+waveFolderPath+", e="+JSON.stringify(e));
                                    } else {
                                        checkUnfinishedTracks();
                                    }
                                })
                            }
                        } else {
                            for (var i=0; i<files.length; i++) {
                                if (files[i].indexOf("UNFINISHED") > -1) {
                                    unfinishedWaveform.push(files[i]);

                                    let unlinkPath = path.join(SCUtils.CWD,scSettings.soundcloudWaveformCacheDirectory,files[i]);
                                    fs.unlink(unlinkPath, err => {
                                        if (err) {
                                            console.error("Error unlinking unfinished waveform at path "+path);
                                        }
                                    })
                                }
                            }
                            if (unfinishedTracks.length > 0) {
                                console.log("Found "+unfinishedWaveform.length+" unfinished waveforms, deleted");
                            }
                            
                        }
                    });
                }
                checkUnfinishedTracks();



                loadTrackIndex(0); //start track loading (recursive)
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
            if (!trackObject.id || !trackObject.title || !trackObject.artwork || !trackObject.artwork.waveformUrl) { //it's okay if it's missing the artwork URL
                return reject("saveTrack TrackObject is invalid, full "+JSON.stringify(trackObject));
            }
            var trackID = trackObject.id;
            if (SCUtils.debugMode) {
                console.log("Fetching SC track '"+trackObject.title+"' artwork, track, & waveform");
            }


            var unfinTrackPath = path.join(SCUtils.CWD,scSettings.soundcloudTrackCacheDirectory,("track-"+trackID+"-UNFINISHED.mp3"));
            var trackPath = path.join(SCUtils.CWD,scSettings.soundcloudTrackCacheDirectory,("track-"+trackID+".mp3"));
            var trackFolderPath = path.join(SCUtils.CWD,scSettings.soundcloudTrackCacheDirectory);

            var unfinArtPath = path.join(SCUtils.CWD,scSettings.soundcloudArtworkCacheDirectory,("art-"+trackID+"-UNFINISHED.jpg"));
            var artPath = path.join(SCUtils.CWD,scSettings.soundcloudArtworkCacheDirectory,("art-"+trackID+".jpg"));
            var artFolderPath = path.join(SCUtils.CWD,scSettings.soundcloudArtworkCacheDirectory);
            var noArtPath = path.join(SCUtils.CWD, scSettings.noArtworkUrlPrefix, scSettings.noArtworkUrl); //no artwork path

            var unfinWavePath = path.join(SCUtils.CWD,scSettings.soundcloudWaveformCacheDirectory,("waveform-"+trackID+"-UNFINISHED.png"));
            var wavePath = path.join(SCUtils.CWD,scSettings.soundcloudWaveformCacheDirectory,("waveform-"+trackID+".png"));
            var waveFolderPath = path.join(SCUtils.CWD,scSettings.soundcloudWaveformCacheDirectory);

            if (SCUtils.debugMode) {console.log("Checking if folders exist @path="+trackFolderPath+", @path="+artFolderPath+", @path="+waveFolderPath+"...")};
            if (!fs.existsSync(trackFolderPath)) {
                console.log("Track folder doesn't exist... WTF (why u break my code) but okay?");
                try {
                    fs.mkdirSync(trackFolderPath);
                } catch(e) {
                    return reject("Track folder did not exist and attempted to make one and encountered error: "+e);
                }
            }
            if (!fs.existsSync(artFolderPath)) {
                console.log("Art folder doesn't exist... WTF (why u break my code) but okay?");
                try {
                    fs.mkdirSync(artFolderPath);
                } catch(e) {
                    return reject("Art folder did not exist and attempted to make one and encountered error: "+e);
                }
            }
            if (!fs.existsSync(waveFolderPath)) {
                console.log("Wave folder doesn't exist... WTF (why u break my code) but okay?");
                try {
                    fs.mkdirSync(waveFolderPath);
                } catch(e) {
                    return reject("Wave folder did not exist and attempted to make one and encountered error: "+e);
                }
            }
            //console.log("Checking if track exists at path "+trackPath);
            var trackOK = false;
            var artOK = false;
            var waveOK = false;

            //load the track
            fs.readFile(trackPath, (err, data) => {
                if (err) {
                    if (SCUtils.debugMode) {
                        console.log("Track does not exist, downloading at path "+unfinTrackPath);
                    }
                    fetch("http://api.soundcloud.com/tracks/"+String(trackID)+"/stream?client_id="+scSettings.clientID, {timeout: scSettings.requestTimeout}).then(function(response){
                        //console.log("SC RESPONSE URL: "+response.url+", HEADERS: "+JSON.stringify(response.headers.entries()));
                        remoteFileSize(response.url, function(err, size) { //get size of file
                            if (err) {
                                if (err.toString().indexOf("401") > 0) {
                                    console.warn("A 401 error was recieved on attempt to get size; denied. Can't fetch track");
                                    SCUtils.track401Offset++;
                                    return resolve();
                                } else {
                                    return reject("Error getting SC file size: "+err);
                                }
                            } else {
                                if (SCUtils.debugMode) {
                                    console.log("Got track URL and size. SIZE: "+size);
                                }
                                new Promise((sresolve, sreject) => {
                                    if (SCUtils.debugMode) {
                                        console.log("writing to path: "+unfinTrackPath);
                                    }
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
                                        if (SCUtils.debugMode) {
                                            console.log(""); //clear progress bar
                                            console.log("Renaming to finished track");
                                        }
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
                                            return resolve();
                                        } else {
                                            return sreject(err);
                                        }
                                    });
                                }).then( () => {
                                    if (SCUtils.debugMode) {
                                        console.log("Track '"+trackObject.title+"' written successfully, resolving");
                                    }
                                    trackOK = true;
                                    if (artOK && waveOK) { //if the other 2 are done, resolve
                                        return resolve();
                                    }
                                }).catch( err => {
                                    console.error("Error writing SC track: "+err);
                                    return reject(err);
                                });
                            }
                        });
                    }).catch(e => {
                        return reject("Error fetching track stream URL");
                    });
                } else {
                    if (SCUtils.debugMode) {
                        console.log("Track '"+trackObject.title+"' found already");
                    }
                    trackOK = true;
                    if (artOK && waveOK) { //if the other 2 are done, resolve
                        return resolve();
                    }
                }
            });


            //load the art
            if (trackObject.artwork.artworkUrl) {
                fs.readFile(artPath, (err, data) => {
                    if (err) {
                        if (SCUtils.debugMode) {
                            console.log("Art does not exist, downloading at path "+unfinArtPath+" from online file "+trackObject.artwork.artworkUrl);
                        }
                        fetch(trackObject.artwork.artworkUrl, {timeout: scSettings.requestTimeout}).then(function(response){

                            new Promise((sresolve, sreject) => {
                                if (SCUtils.debugMode) {
                                    console.log("writing to path: "+unfinArtPath);
                                }
                                const dest = fs.createWriteStream(unfinArtPath); //write to unfinished track path first

                                response.body.pipe(dest);
                                response.body.on('error', err => {
                                    return sreject(err);
                                });
                                dest.on('finish', () => {
                                    if (SCUtils.debugMode) {
                                        console.log(""); //clear progress bar
                                        console.log("Renaming to finished art");
                                    }
                                    fs.rename(unfinArtPath, artPath, err => {
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
                                if (SCUtils.debugMode) {
                                    console.log("Art '"+trackObject.title+"' written successfully, resolving");
                                }
                                artOK = true;
                                if (trackOK && waveOK) { //if the other 2 are done, resolve
                                    return resolve();
                                }
                            }).catch( err => {
                                console.error("Error writing SC art: "+err);
                                return reject(err);
                            });
                        }).catch(e => {
                            return reject("Error fetching art URL");
                        });
                    } else {
                        if (SCUtils.debugMode) {
                            console.log("Art '"+trackObject.title+"' found already");
                        }
                        artOK = true;
                        if (trackOK && waveOK) { //if the other 2 are done, resolve
                            return resolve();
                        }
                    }
                });
            } else { //artwork url is not defined
                console.log("Artwork URL not defined for track, copying missing audio instead");

                new Promise((sresolve, sreject) => {
                    if (SCUtils.debugMode) {
                        console.log("writing to path: "+unfinArtPath);
                    }
                    const source = fs.createReadStream(noArtPath);
                    const dest = fs.createWriteStream(unfinArtPath); //write to unfinished track path first

                    source.pipe(dest);
                    source.on('error', err => {
                        return sreject(err);
                    });
                    dest.on('finish', () => {
                        if (SCUtils.debugMode) {
                            console.log(""); //clear progress bar
                            console.log("Renaming to finished art");
                        }
                        fs.rename(unfinArtPath, artPath, err => {
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
                    if (SCUtils.debugMode) {
                        console.log("Art '"+trackObject.title+"' written successfully, resolving");
                    }
                    artOK = true;
                    if (trackOK && waveOK) { //if the other 2 are done, resolve
                        return resolve();
                    }
                }).catch( err => {
                    console.error("Error writing SC noart: "+err);
                    return reject(err);
                });
            }

            //load the waveform
            fs.readFile(wavePath, (err, data) => {
                if (err) {
                    if (SCUtils.debugMode) {
                        console.log("Waveform does not exist, downloading at path "+unfinWavePath+" from online file "+trackObject.artwork.waveformUrl);
                    }
                    fetch(trackObject.artwork.waveformUrl, {timeout: scSettings.requestTimeout}).then(function(response){

                        new Promise((sresolve, sreject) => {
                            if (SCUtils.debugMode) {
                                console.log("writing to path: "+unfinWavePath);
                            }
                            const dest = fs.createWriteStream(unfinWavePath); //write to unfinished track path first

                            response.body.pipe(dest); //pipe body to dest
                            response.body.on('error', err => {
                                return sreject(err);
                            });
                            dest.on('finish', () => {
                                if (SCUtils.debugMode) {
                                    console.log(""); //clear progress bar
                                    console.log("Renaming to finished wave");
                                }
                                fs.rename(unfinWavePath, wavePath, err => {
                                    if (err) {
                                        return sreject("Error renaming wave");
                                    } else {
                                        return sresolve();
                                    }
                                });
                            });
                            dest.on('error', err => {
                                return sreject(err);
                            });
                        }).then( () => {
                            if (SCUtils.debugMode) {
                                console.log("Wave '"+trackObject.title+"' written successfully, resolving");
                            }
                            waveOK = true;
                            if (trackOK && artOK) { //if the other 2 are done, resolve
                                return resolve();
                            }
                        }).catch( err => {
                            console.error("Error writing SC wave: "+err);
                            return reject(err);
                        });

                    }).catch(e => {
                        return reject("Error fetching wave URL");
                    });
                } else {
                    if (SCUtils.debugMode) {
                        console.log("Track '"+trackObject.title+"' waveform found already");
                    }
                    waveOK = true;
                    if (trackOK && artOK) { //if the other 2 are done, resolve
                        return resolve();
                    }
                }
            });

        });

    
    }
}

var SCSoundManager = {
    playingTrack: false,
    currentVolume: 50,

    MINVOLUME: 0, //pcm constants, shouldn't be changed for any reason
    MAXVOLUME: 1.5,

    currentPlayingTrack: {},
    currentPlayingTrackDuration: 0,
    currentPlayingTrackPlayed: 0,
    trackTimeInterval: 0,
    canInteractTrack: true,
    canInteractTrackTimeout: 0,

    trackControl: {
        play: function(){},
        pause: function(){}
    },

    clientUpdateInterval: {},

    init: () => {
        return new Promise((resolve, reject) => {
            SCSoundManager.currentPlayingTrack = SCUtils.localSoundcloudSettings.likedTracks[0]; //start with first track
            SCSoundManager.currentVolume = SCUtils.localSoundcloudSettings.defaultVolume;
            //SCSoundManager.playTrackLogic(this.currentPlayingTrack);
            resolve();
        });
    },
    lookupTrackByID: trackID => {
        return new Promise((resolve, reject) => {
            if (typeof trackID == "undefined") {
                return reject("[ERROR] TrackID undefined");
            }
            var lt = SCUtils.localSoundcloudSettings.likedTracks;
            for (var i=0; i<lt.length; i++) {
                if (lt[i].id == trackID) {
                    return resolve(lt[i]);
                }
            }
            return reject("[ERROR] Can't find track");
        });
    },
    processClientEvent: function(ev) {
        return new Promise( (resolve, reject) => {
            if (ev && ev.type) {
                console.log("[SCSoundManager] ClientEvent: "+ev.type+", origin: "+((ev.origin) ? ev.origin : "unknown (external)")+", dat: "+JSON.stringify((ev.data) ? ev.data : "no data provided"));
                try {
                    ev.data = JSON.parse(ev.data);
                } catch(e) {}

                if (SCSoundManager.canInteractTrack || ev.type.indexOf("volume") > -1 || ev.type.indexOf("changeTrack") > -1 || ev.type == "togglePlayerOutput") {
                    
                    if (ev.type.indexOf("volume") == -1 && ev.type.indexOf("changeTrack") == -1 && ev.type != "togglePlayerOutput") { //vol changetrackstate and toggleoutput no limits
                        SCSoundManager.canInteractTrack = false;
                        clearTimeout(SCSoundManager.canInteractTrackTimeout);
                        SCSoundManager.canInteractTrackTimeout = setTimeout(function(){
                            SCSoundManager.canInteractTrack = true;
                        }, (ev.type.indexOf("clientTrackSelected") > -1) ? SCUtils.localSoundcloudSettings.minInteractionWaitTime*SCUtils.localSoundcloudSettings.trackSelectedWaitMultiplier : SCUtils.localSoundcloudSettings.minInteractionWaitTime);
                    }

                    switch (ev.type) {
                        case "playPause":
                            if (SCSoundManager.playingTrack) {
                                SCSoundManager.trackControl.pause();
                                SCSoundManager.playingTrack = false;
                            } else {
                                SCSoundManager.trackControl.play();
                                SCSoundManager.playingTrack = true;
                            }
                            break;
                        case "volumeUp":
                            if (SCSoundManager.currentVolume+SCUtils.localSoundcloudSettings.volStep <= 100) { //ik that it will go > 100 but it is clamped by setplayervolume
                                SCSoundManager.currentVolume+=SCUtils.localSoundcloudSettings.volStep;
                                SCSoundManager.setPlayerVolume(SCSoundManager.currentVolume);
                            }
                            break;
                        case "volumeDown":
                            if (SCSoundManager.currentVolume-SCUtils.localSoundcloudSettings.volStep > 0) {
                                SCSoundManager.currentVolume-=SCUtils.localSoundcloudSettings.volStep;
                                SCSoundManager.setPlayerVolume(SCSoundManager.currentVolume);
                            }
                            break;
                        case "trackForward":
                            if (SCUtils.localSoundcloudSettings.nextTrackLoop && ev.origin.indexOf("internal") > -1) {
                                console.info("Track looping");
                                SCSoundManager.playTrackLogic(SCUtils.localSoundcloudSettings.likedTracks[SCSoundManager.currentPlayingTrack.index]); //replay
                            } else {
                                if (SCUtils.localSoundcloudSettings.nextTrackShuffle) {
                                    var ind = Math.round(Math.random()*(SCUtils.localSoundcloudSettings.likedTracks.length-SCUtils.track401Offset));
                                    if (ind == SCSoundManager.currentPlayingTrack.index) { //is track so add one
                                        ind++;
                                        if (ind > (SCUtils.localSoundcloudSettings.likedTracks.length-SCUtils.track401Offset)) { //lol very random chance that it wrapped over
                                            ind = 0;
                                        }
                                    }
                                    SCSoundManager.playTrackLogic(SCUtils.localSoundcloudSettings.likedTracks[ind]);
                                } else {
                                    var ind = SCSoundManager.currentPlayingTrack.index+1;
                                    if (ind > (SCUtils.localSoundcloudSettings.likedTracks.length-SCUtils.track401Offset)) {
                                        ind = 0; //go to first track
                                    }
                                    //console.info("NOIND OVERFLOW (ind="+ind+", len="+(SCUtils.localSoundcloudSettings.likedTracks.length-SCUtils.track401Offset)+")");
                                    SCSoundManager.playTrackLogic(SCUtils.localSoundcloudSettings.likedTracks[ind]);
                                }
                            }
                            break;
                        case "trackBackward":
                            var ind = SCSoundManager.currentPlayingTrack.index-1;
                            if (ind < 0) {
                                ind = SCUtils.localSoundcloudSettings.likedTracks.length-SCUtils.track401Offset-1; //go to last track
                            }
                            SCSoundManager.playTrackLogic(SCUtils.localSoundcloudSettings.likedTracks[ind]);
                            break;
                        case "clientLocalTrackFinished":
                            SCSoundManager.processClientEvent({
                                type: "trackForward",
                                origin: "internal (client local track finished)"
                            });
                            break;
                        case "clientTrackSelected":
                            if (ev.data) {
                                var trackID = ev.data;
                                if (typeof trackID == "undefined") {
                                    return reject("ClientTrackSelected event fired but no trackID data was provided");
                                } else {
                                    SCSoundManager.lookupTrackByID(trackID).then( trackData => {
                                        SCSoundManager.playTrackLogic(trackData);
                                    }).catch( err => {
                                        return reject("Error looking up track with id "+trackID+": "+err);
                                    })
                                }
                                
                            } else {
                                return reject("ClientTrackSelected event fired but no data provided");
                            }
                            break;
                        case "changeTrackLoopState":
                            SCUtils.localSoundcloudSettings.nextTrackLoop = !SCUtils.localSoundcloudSettings.nextTrackLoop;
                            break;
                        case "changeTrackShuffleState":
                            SCUtils.localSoundcloudSettings.nextTrackShuffle = !SCUtils.localSoundcloudSettings.nextTrackShuffle;
                            break;
                        case "togglePlayerOutput":
                            SCUtils.localSoundcloudSettings.playMusicOnServer = !SCUtils.localSoundcloudSettings.playMusicOnServer;
                            console.log("Toggled player output to "+SCUtils.localSoundcloudSettings.playMusicOnServer);
                            break;
                        default:
                            console.warn("unknown event "+JSON.stringify(ev)+" passed into SCProcessClientEvent");
                            return reject("unknown event "+JSON.stringify(ev)+" passed into SCProcessClientEvent");
                            break;
                    }
                    return resolve();
                } else {
                    return reject("SCSoundManager cannot process event because the minimum time between events has not elapsed")
                }
            } else {
                return reject("SCSoundManager proc cliEv called with no event or invalid");
            }
        });
    },

    playTrackLogic: function(trackObject) {
        if (trackObject) {
            clearInterval(SCSoundManager.clientUpdateInterval); //clear the client update loop
            if (SCUtils.localSoundcloudSettings.playMusicOnServer) {
                console.log("Playing music on: SERVER");
                if (SCSoundManager.playingTrack) {
                    SCSoundManager.trackControl.pause(); //pause track so that two tracks don't overlap
                    SCUtils.playingTrack = false;
                    setTimeout(function() {
                        playT();
                    },500); //give it time to pause
                } else {
                    playT();
                }

                function playT() {
                var trackPath = path.join(SCUtils.CWD,SCUtils.localSoundcloudSettings.soundcloudTrackCacheDirectory,("track-"+trackObject.id+".mp3"));
                    fs.stat(trackPath, function(err, stat) {
                        if (err) {
                            console.warn("Track with title: "+trackObject.title+" had no copy saved locally; downloading one (was it deleted somehow?)");
                            SCUtils.saveTrack(trackObject, SCUtils.localSoundcloudSettings).then( () => {
                                SCSoundManager.playTrackServer(trackObject);
                            }).catch( err => {
                                console.error("Error playing track with title: "+trackObject.title+"; no copy saved locally and couldn't download (protected track?)");
                            })
                        } else {
                            SCSoundManager.playTrackServer(trackObject);
                        }
                    });
                }
            } else {
                console.log("Playing music on: CLIENT");
                //PROGRAM CLIENT PLAY MUSIC
            }
        } else {
            console.error("Invalid track passed into playTrackLogic");
        }
    },
    
    getPercent: function() {
        return (SCSoundManager.currentPlayingTrackPlayed/SCSoundManager.currentPlayingTrackDuration)*100;
    },

    getPlayedSeconds: function() {
        return SCSoundManager.currentPlayingTrackPlayed;
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
        SCUtils.localSoundcloudSettings.currentVolume = SCSoundManager.currentVolume;
    },
    playTrackServer: function(trackObject) {
        var trackPath = path.join(SCUtils.CWD,SCUtils.localSoundcloudSettings.soundcloudTrackCacheDirectory,("track-"+trackObject.id+".mp3"));
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
                        SCSoundManager.currentPlayingTrackPlayed = 0;
                        SCSoundManager.currentPlayingTrack = trackObject;

                        var readable = fs.createReadStream(trackPath); //create the read path

                        var ts = new timedStream({
                            rate: 1000000,
                            period: 100
                        }); //initialize timedStream
                        
                        var audioOptions = { //set audio options
                            channels: 2,
                            bitDepth: 16,
                            sampleRate: 44100,
                            bitRate: 128,
                            outSampleRate: 22050,
                            mode: lame.STEREO
                        };

                        var decoder = new lame.Decoder(audioOptions); //initialize decoder
                        var volumeTweak = new pcmVolume(); //initialize pcm volume changer

                        SCSoundManager.pcmVolumeAdjust = volumeTweak; //set global method so it can be accessed

                        SCSoundManager.setPlayerVolume(SCSoundManager.currentVolume);


                        readable.pipe(ts) //pipe stream to timedStream
                            .pipe(decoder) //pipe to decoder
                            .pipe(volumeTweak) //pipe to volumeTweaker
                        
                        var speaker;
                        function resume() {
                            if (!SCSoundManager.playingTrack) {
                                console.info("_PLAY");

                                speaker = new Speaker(audioOptions); //setup speaker

                                volumeTweak.pipe(speaker); //setup pipe for volumeTweak
                                ts.resumeStream(); //resume the stream
                                SCUtils.playingTrack = true;

                                SCSoundManager.trackTimeInterval = setInterval(function() {
                                    SCSoundManager.currentPlayingTrackPlayed+=0.1; //add the time to the counter
                                },100);

                                return speaker.once('close', function() {
                                    speaker.end();
                                    ts.destroy();
                                    SCSoundManager.playingTrack = false;
                                    clearInterval(SCSoundManager.trackTimeInterval);
                                    console.log("_NEXT SONG REACHED");

                                    SCSoundManager.processClientEvent({
                                        type: "trackForward",
                                        origin: "internal (trackFinished)"
                                    }); //request next track
                                })
                            }
                            //volumeTweak.pipe(spk); //pipe adjusted volume tweak stream to speaker (which will play it)
                            //decoder.pipe(volumeTweak); //pipe decoder to volumeTweaker to change volume
                            
                        }

                        function pause() {
                            if (SCSoundManager.playingTrack) {
                                console.info("_PAUSE");
                                clearInterval(SCSoundManager.trackTimeInterval);
                                SCUtils.playingTrack = false;
                                speaker.removeAllListeners('close');
                                volumeTweak.unpipe(speaker);
                                ts.pauseStream();
                                speaker.close();
                                return speaker.end();
                            }
                        }

                        SCSoundManager.trackControl = { //set the track control handler
                            pause: pause,
                            play: resume
                        };

                        if (SCUtils.localSoundcloudSettings.autoplayTrack) {
                            SCSoundManager.playingTrack = false;
                            resume(); //start playing track
                            SCSoundManager.playingTrack = true;
                        } else {
                            SCSoundManager.playingTrack = false;
                        }

                        console.info("INIT DONE: "+trackObject.title);
                    }
                });
            } else {
                return console.error("File doesn't exist");
            }
        })
    }
}

exports.SCUtils = SCUtils;
exports.SCSoundManager = SCSoundManager;