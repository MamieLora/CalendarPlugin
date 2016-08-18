/*
Copyright (c) 2016 KeeeX SAS 

This is an open source project available under the MIT license.
Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:
The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

*/

var fs = require('fs');
var path = require('path');
var gui = require('nw.gui');
var async = require('async');
var _ = require('underscore');
var moment = require('moment');
var readline = require('readline');
var google = require('googleapis');
var kxapi = require('keeex-api');
var chronoParse = require('chrono-node');
var utils = require('./js/utils.js').utils;
var googleAuth = require('google-auth-library');

// KeeeX Constants
var KEEEX_EVENT_IDX;
var KEEEX_EVENT_CANCELLED_IDX;
var KEEEX_MESSAGE_IDX = "xohos-dukyh-nahiv-pokeb-murem-lyfoh-lafoc-gicod-gevan-rehen-vefos-kylob-fabel-forib-kicop-hahym-puxax";
var KEEEX_PATH;
var KEEEXED_PATH;

// Google Calendar API vars
var GOOGLEAPIS_SCOPES;
var GOOGLEAPIS_TOKEN_DIR;
var GOOGLEAPIS_TOKEN_PATH;
var gCal;
var maxTimeDidNotChanged = false;
var googleMaxTimeSync = moment();
var googleMaxResult = 10;

// Timeline vars 
var svg_TimeLine;
var autoSpot = true;
var zoomLevel = 1;
var zoomGap = 40;
var spotTime;
var updateInterval;
var zoomPosition;
var timeLabels;
var eventLabels;
var timeLabelLeft;
var timeLabelRight;
var numberOfEventLevel; 
var startX;
var endX;
var isMouseDown;
var oldNow;
var minZoomLevel = 0;
var maxZoomLevel = 3;
var minGap = 40;
var maxGap = 150;
var zoomTimeDistance = [15 * 60000, 30 * 60000, 3 * 60 * 60000, 12 * 60 * 60000]; //ms
var marginTop = 60;
var colors = d3.scale.category10().domain(d3.range(1));
var refreshDataInterval;
var appFinishedInit = false;

//// KeeeX User backbone objects

/* Backbone Model EventParticipant - KeeexUser, contains all data related to an user */
var EventParticipant = Backbone.Model.extend({
	defaults: {
		idx: null,
		name: "Unknown...",
		name_lc : "Unknown...",
		email: "",
		avatar: "",
		start: "",
		checked: false,
	},
});

/* Backbone Collection EventParticipantList - The collection containing all users we know of */
var EventParticipantList = new (Backbone.Collection.extend({
	model: EventParticipant,
	comparator: 'name_lc',

	search : function(letters){
		if(letters === "") return this;

		var pattern = new RegExp(letters,"i");
		return new Backbone.Collection(this.filter(function(data) {
		  	return pattern.test(data.get("name"));
		}));
	},

	toogleCheck: function(uidx){
		var m = this.findWhere({idx: uidx});

		if(m.get('checked')){
			m.set('checked', false);
		}else {
			m.set('checked', true);
		}
	},

	clearChecks: function(){
		this.forEach(function(m){
			m.set('checked', false);
		});
	}

}))();

/* Backbone View participantViewChecklist - View displaying an user pic + name + selection checkbox  */
var participantViewChecklist = Backbone.View.extend({
    tagname: "div",
    model: EventParticipant,

	// TODO : Using a template would make this less ugly, right ?
    render: function (){
        this.$el.html('<label for="' + this.model.get("idx") + '">' +
        '<img class="detail_avatar" src="' + (this.model.get("avatar")? this.model.get("avatar") :  "./images/default-avatar.png")  + '"' +
        'alt="' + this.model.get("name") + '">' + this.model.get('name') + '</label>' +
        '<input type="checkbox" name="shareContact" id="' + this.model.get("idx") + '" ' +(this.model.get("checked")? "checked " : " ") +
        'onclick="EventParticipantList.toogleCheck(\'' + this.model.get("idx") + '\')"></div>');
        return this;
    }
});

/* Backbone View for the collection EventParticipantList - Uses participantViewChecklist for each user    */
var participantListViewChecklist = Backbone.View.extend({
    collection: EventParticipantList,

	events: {
		"keyup .searchParticipant" : "search"
	},

	initialize: function(){
		$(this.el).find(".searchParticipant").val('');
		EventParticipantList.clearChecks();
	},

	search: function(e){
		var letters = $(this.el).find(".searchParticipant").val();
		this.render(this.collection.search(letters));
	}, 

    render: function(participants) {
        $(this.el).find(".dialog_possibleShares").empty(); // lets render this view

        if(participants === undefined){
        	participants = this.collection;
        }

        for(var i = 0; i < participants.length; ++i) {
            // lets create a book view to render
            if(participants.at(i).get('status') === "ACCEPTED" && participants.at(i).get('idx') != keeexUserInfo.profileIdx){
	        	var m_participantViewChecklist = new participantViewChecklist({model: participants.at(i)});

	        	// lets add this book view to this list view
	        	$(this.el).find(".dialog_possibleShares").append(m_participantViewChecklist.$el); 
	        	m_participantViewChecklist.render(); 
	        }          
        } 

		// Dirty hack solving display issues
		$( ".bigDialog_secondaryColumn" ).hide(0);
		$( ".bigDialog_secondaryColumn" ).show(1);

         return this;
    },
});

//// KeeeX Topic backbone objects

/* Backbone Model - CalendarEvent, contains all data related to an event */
var CalendarEvent = Backbone.Model.extend({
	defaults: {
		idx: "unkeeexed",
		gCalId: null,
		name: "Not specified",
		description: "",
		location: "",
		start: "",
		end: "",
		level: 1,
		toRemove: false,
		creationDate: "",
		participants: [],
		participantsToAdd: [],
	},

	save: function(callback){
		saveEventOnKeeex(this, function(savedEvent, somethingWentWrong){
			if(somethingWentWrong){
				alert("Can't save the event called " + event.get('name') + " in KeeeX :/");
			}

			// If everything was okay, update the google event to store the idx 
			if(gCal !== undefined && !somethingWentWrong){
				if(savedEvent.get('gCalId')) {
					updateEventInGCal(savedEvent, callback);			
				}
				else{
					createEventInGCal(savedEvent, callback);
				}
			}
			else{
				// We'll still need to execute the callback
				if(callback){
					callback();
				}
			}
			

		});
	},
});

/* Backbone Collection -  The collection containing all events we know of  */
var CalendarEventList = new (Backbone.Collection.extend({
	model: CalendarEvent,

	initialize: function(){
		this.bind("add", function(){
			needComputeEventLevels = true;
		});
		this.bind("change", function(){
			needComputeEventLevels = true;
			updateUI();
		});
		this.bind("remove", function(){
			needComputeEventLevels = true;
			updateUI();
		});

		this.comparator = 'start';
	},

	getEventOfday: function(day){
		return this.filter(function (c){
			return moment(c.get('start')).isSame(day, 'day') || moment(day).isBetween(c.get('start'), c.get('end')) ;
		});
	},

	setToRemove: function(){
		this.forEach(function(m){
			m.toRemove = true;
			m.editLock = m.editLock || false;
		});
	},

	cleanRemovableEntries: function(){
		this.forEach(function(m){
			if(m !== undefined && m.toRemove !== undefined && m.toRemove && m.editLock === false && m.idx !== null){
				CalendarEventList.remove(m);
			}
		});
	}
}))();



/* Object - The user's info */
var keeexUserInfo;

/* Moment object - The date curently displayed in the calendar / timeline */
var currentSelectedDate = moment().hours(13).minutes(0);

/* Boolean - Tells if we're updatinf the list of events or not */
var updatingEventList = false;

/* Boolean - Tells to calculate events levels before displaying the Time line */
var needComputeEventLevels = true;

/**
 * Initialize the APP (display and data). Initiate the first data gathering from KeeeX
 */
function initCalendarApp() {
	// Init variables & Events listeners 
	document.getElementsByTagName('body')[0].addEventListener("paste", createNewEventFromClipboard, false);
	setVisible(document.getElementById('div_timeLineEventDetails'), false);
	rootPath = path.dirname(utils.getDirName());

	// Show a popup about the wait 
	setVisible(document.getElementById('div_hider'), true);
	unclickable_popover("Waiting for authorization from KeeeX");
	
	//connect to local API
	kxapi.getToken("KeeeX Calendar", function(err, result){
		if(err) {
			if(err.message == "400 PermissionDenied"){
				// Access denied by the user
				popover("Access to the local API was denied", closePlugin);
			}
			else {
				// Something else went wrong
				popover("Can't connect to the local API.", closePlugin);
			}
		}
		else { 
			// Everythings okay, let's go on !

			// Hide the popup
			setVisible(document.getElementById('div_dialog'), false);
			setVisible(document.getElementById('div_hider'), false);

			async.series([
				function getKeeexPath(callback){
					kxapi.env('KEEEX_PATH', function(err, res){
						if(!err){
							KEEEX_PATH = res.value;
							callback();
						}
						else{
							callback("ERROR : Can't get settings from KeeeX to init the plugin <br /> (KEEEX_PATH)");
						}
					});
				},
				function getKeeexedPath(callback){
					kxapi.env('KEEEXED_PATH', function(err, res){
						if(!err){
							KEEEXED_PATH = res.value;
							callback();
						}
						else{
							callback("ERROR : Can't get settings from KeeeX to init the plugin <br /> (KEEEXED_PATH)");
						}
					});
				},
				// Get the IDX of the "Event" tag for finding & tagging our events (+add it to keeex db is absent)
				function getEventIDX(callback){
					kxapi.verify(rootPath + "/template/event.kxconcept", {import: true},  function(err, res){
						if(!err){
							KEEEX_EVENT_IDX = res.idx;
							callback();
						}
						else{
							callback("ERROR : Can't get settings from KeeeX to init the plugin <br /> (KEEEX_EVENT_IDX)");
						}
					});
				},
				// Get the IDX of the "Event Cancelled" tag for finding & tagging our events (+add it to keeex db is absent)
				function getEventCancelledIDX(callback){
					kxapi.verify(rootPath + "/template/eventCancelled.kxconcept", {import: true}, function(err, res){
						if(!err){
							KEEEX_EVENT_CANCELLED_IDX = res.idx;
							callback();
						}
						else{
							callback("ERROR : Can't get settings from KeeeX to init the plugin <br /> (KEEEX_EVENT_CANCELLED_IDX)");
						}
					});
				},
				function getUserInfo(callback){
					// Fetch user's info
					kxapi.getMine(function (error, currentUser) {
						if (!error) {
							keeexUserInfo = currentUser; 

							// Display user's name and avatar
							document.getElementById('span_keeexUserName').innerHTML = keeexUserInfo.name.substring(0, keeexUserInfo.name.indexOf(' '));
							document.getElementById('img_keeexUserAvatar').setAttribute('src', keeexUserInfo.avatar ? keeexUserInfo.avatar : "");
							callback();
						}
						else {
							callback("ERROR : Can't get user info from KeeeX to init the plugin");
						}
					});

				},
				function startCalendar(){
					// Now we can init our UI
					initEventTimeLine();
					initCalendar();
					updateEventTimeLine();
					showCalendarAt(currentSelectedDate);

					// Load events
					updateCalendarData();

					// Register UI and data refresh
					refreshDataInterval = setInterval(updateCalendarData, 15000);
					setInterval(updateUI, 300000);

					appFinishedInit = true;
				}
			], function seriesCallback(error){
				if(error){
					popover(error, closePlugin);
				}
			});

			// Fetch all known users
			kxapi.getUsers(null, function(err, body){
				if(!err){
					body.forEach(createParticipantFromKeeexUserInfo);
				}
			});

		}
	});
}

/**
 * Initiate the update of the calendar data. First from Keeex, then, from 3rd parties (if connected)
 */
function updateCalendarData(){
	// Make sure no update is still running
	if(updatingEventList){
		console.log("Wont update events, an update is already running :0");
		return;
	}

	updatingEventList = true;
	console.log('Starting to update events....');

	// Make sure each step run after the last one is completely finished
	async.series([fetchEventsFromKeeex, fetchEventsFromGCal, pushEventsToGCal], function(err){
		console.log('Update finished');
		updatingEventList = false;
	});
}

/**
 * Create a new event with the given name and description. 
 *
 * @param {string} eventName - The name of the event
 * @param {string} eventDescription - The description of the event
 * @param {moment} startTime - The date and time of event start
 * @param {moment} endTime - The date and time of event end
 * @param {Array[string]} recipients - An array of recipients idx that shall receive the event
 */
function createNewEvent(eventName, eventDescription, startTime, endTime, recipients){
	var event = new CalendarEvent();
	event.editLock = true;
	event.set('name', eventName.trim());
	event.set('creationDate', moment());
	event.set('start', startTime);
	event.set('end', endTime);
	event.set('description', eventDescription.trim());
	event.set('participants', [] );
	event.set('participantsToAdd', recipients || [] );

	CalendarEventList.add(event);
	event.save();
}

/**
 * Edit an event given with the given name and description.
 *
 * @param {calendarEvent} event - The event to edit
 * @param {string} eventName - The name of the event
 * @param {string} eventDescription - The description of the event
 * @param {moment} startTime - The date and time of event start
 * @param {moment} endTime - The date and time of event end
 * @param {Array[string]} recipients - An array of recipients idx to add to the event
 */
function editEvent(event, eventName, eventDescription, startTime, endTime, recipients){
	event.editLock = true;
	event.set({name: eventName.trim(),
		      start: startTime,
			  end: endTime,
			  description: eventDescription.trim(),
			  participantsToAdd: recipients || []});

	event.save();
}

/**
 * Update the user interface (Eventlist, calendar, timeline)
 */
function updateUI(){
	updateEventListView();
	showCalendarAt();
	updateEventTimeLine();
}

/**
 * Parse the given text with the reference time (usualy, when the text was written) to detect an event time and date
 * If 2 dates are found, one will be the event start, the other the event end.
 * If one time intervall is found, it will determinate event time start and end.
 * If there's just a start date, it will assume a duration of 1hour
 * If date at all, it will use the reference time and duration of 1hour
 *
 * @param {String} eventText - The event textual description (usually in natural language)
 * @param {moment} referenceTime - The temporal reference for the text (usefull for indicators like "Tomorrow")
 */
function extractTimeAndDateFromText(eventText, referenceTime){
	var eventTime = {};
	var parsingResult = chronoParse.parse(eventText, referenceTime);

	if(parsingResult.length === 0){
		console.log("Can't parse event : %s", eventText);
		eventTime.start = referenceTime;
		eventTime.end = moment(eventTime.start).add(1, 'hour');
	}
	else if(parsingResult.length == 1 || (parsingResult.length >= 2 && typeof parsingResult[0].end !== 'undefined' )){
		eventTime.start =  (parsingResult[0].start) ? moment(parsingResult[0].start.date()) : referenceTime;
		eventTime.end =  (parsingResult[0].end) ?  moment(parsingResult[0].end.date()) : moment(eventTime.start).add(1, 'hour');
	}
	else if(parsingResult.length >= 2) {
		eventTime.start = (parsingResult[0].start) ? moment(parsingResult[0].start.date()) : referenceTime;
		eventTime.end =  (parsingResult[1].start) ?  moment(parsingResult[1].start.date()) : moment(eventTime.start).add(1, 'hour');
		
	} else {
		eventTime.start = moment(referenceTime);
		eventTime.end =  moment(referenceTime).add(1, 'hour');
	}

	return eventTime;
}


/**
 * Will close the plugin (and should end every thing happening in background)
 */
function closePlugin () {
	global.window.nwDispatcher.requireNwGui().Window.get().close();
}


//////////////////////////////////////////////
//  			Keeex functions				//
//////////////////////////////////////////////

/**
 * Update the event collection with data from keeex with topics that have the "Event" tag
 *
 * @param {function} callback - A callback to be called at the end of the update process
 */
function fetchEventsFromKeeex(callback) {
	console.log("Gathering data from KeeeX");

	// Flags all events we know as to be removed, We'll unflag them as we fetch their data from KeeeX
	CalendarEventList.setToRemove();

	// Search for all event in KeeeX (filter, topics, negTopics, skip, limit, option, callback)
	kxapi.search("", [KEEEX_EVENT_IDX], [KEEEX_EVENT_CANCELLED_IDX], 0, 0, {document:true, discussion:true, older_version:false},  function (err, topics) {
		
		if(err) { 
			// Search API error
			console.error("Can't retrive list of topics ", err);

			if(callback){
				//SHOULD NOT BE UNCOMMENTED UNTIL PROPER ERROR HANDLING
				//callback();
			}
		}
		else {
			if (topics === undefined || topics.length === 0) {
				console.log('No events in KeeeX');

				if(callback){
					callback();
				}
			}
			else {
				console.log("Got " + topics.length + "events from Keeex");
				async.each(topics, function(topic, callbackAsync){

					// Remove the event tag if present in the search result - But this is not supposed to happend
					if (topic.idx == KEEEX_EVENT_IDX) {
						callbackAsync();
						return;
					}

					// Do we know this event already?
					var known = CalendarEventList.where({idx: topic.idx});
					if(known.length > 0){
						known[0].toRemove = false;
					}
					else {
						createEventFromKeeexTopic(topic);
					}

					var event = CalendarEventList.findWhere({idx: topic.idx});

					// Fetch events participants
					kxapi.getShared(topic.idx, function(err, userList){
						if(err){
							console.error("Can't retrive list of participants of topic %s", topic.idx, err);
						}
						else {
							if(userList !== null && userList.shared.length > 0){
								
								userList.shared.forEach(function(uidx){
									// Add the participant to the topic if it wasn't already here 
									if(event.get('participants').indexOf(uidx) < 0){
										event.get('participants').push(uidx);
									}

									// Fecht the user's data if we don't know it
									if(EventParticipantList.where({idx: uidx}).length === 0 ){
										kxapi.getUsers([uidx], function(err, userInfos){
											if(!err){
												createParticipantFromKeeexUserInfo(userInfos[0]);
											}
											else{
												console.error("Can't retrive informations of %s", uidx, err);
											}
										});
									}
								});
							}
						}
					});

					callbackAsync();

				}, function callbackAsyncEvent(){  // Called after async.each finished to walk through all topics from Keeex

					// Remove all entries that are still flagged
					CalendarEventList.cleanRemovableEntries();
					updateUI();

					if(callback){
						callback();
					}
				});
			}
		}
	});
}

/**
 * Create and initialize an user with a KeeeX user info
 *
 * @param {object} keeexUserInfo - The KeeeX user info to extract data
 */
function createParticipantFromKeeexUserInfo(keeexUserInfo){
	p = new EventParticipant();

	p.set('idx', keeexUserInfo.profileIdx);
	p.set('name', keeexUserInfo.name);
	p.set('name_lc', keeexUserInfo.name.toLowerCase());
	p.set('email', keeexUserInfo.email);
	p.set('avatar', keeexUserInfo.avatar);
	p.set('status', keeexUserInfo.state);

	EventParticipantList.add(p);
}

/**
 * Create and initialize an event with a KeeeX topic
 *
 * @param {object} keeexTopic - The KeeeXtopic to extract data
 */
function createEventFromKeeexTopic(keeexTopic){
	e = new CalendarEvent();

	e.set('idx', keeexTopic.idx);
	e.set('name', keeexTopic.name.trim());
	e.set('description', br2nl(removeTimeTag(keeexTopic.description || "" )).trim());
	e.set('location', "");
	e.set('start', moment(keeexTopic.creationDate));
	e.set('end', moment(keeexTopic.creationDate).add(1, 'hour'));
	e.set('creationDate', moment(keeexTopic.creationDate));
	e.set('participants', []);
	e.set('participantsToAdd', []);
	e.toRemove = false;

	parseEventDataFromKeeex(e, keeexTopic);

	CalendarEventList.add(e);
}

/**
 * Save the event on KeeeX. 
 * If the event already exist, it will be set as previous version of the new one
 *
 * @param {CalendarEvent} event - The event to save
 * @param {function} callback - A callback triggered at the end of the save
 */
function saveEventOnKeeex(event, callback){
	// Make sure an update won't trouble our plans
	event.editLock = true;

	// Shorten the name if too long (>100 chars)
	if(event.get('name').length > 100){
		// Repeat the full event name in description to not break context
		event.set('description', event.get('name') + " \n\n" + event.get('description'));
		event.set('name', event.get('name').substring(0,95)+"...");
	}

	kxapi.generateFile(event.get('name'), event.get('description').trim() + " " + getKeeexEventTimeTag(event.get('start'), event.get('end')), (KEEEX_PATH + '/temp/'), function(err, body){
		if(err) {
			event.editLock = false;

			console.error("kxapi.generateFile returned an error for event %s", event.get('name'), err);
			callback(event, true);
		}
		else{

			// Tag the event as a KeeeX Message and as an event
			refs = [KEEEX_MESSAGE_IDX, KEEEX_EVENT_IDX];

			// If teh event was already keeexed, we mention it as a previous version.  
			previous = [];
			if(event.get('idx') !== 'unkeeexed'){
				previous.push(event.get('idx'));
			}

			// Few more options (destination folder etc...)
			var option = {
				targetFolder: KEEEXED_PATH, 
				timestamp:false, 
				name: null,
				except: {
					name: true,
					desc: true
				}
			};

			// We can KeeeX it
			kxapi.keeex(body.file, refs, previous, null, option, function(err, res){
				if(err){
					console.error("kxapi.keeex returned an error for event %s", event.get('name'), err, event);
					event.editLock = false;

					if(callback){
						callback(event, false);
					}
				}
				else {
					// Save the new idx of the event
					event.set('idx', res.topic.idx);
					event.editLock = false;

					if(event.get('participantsToAdd').length > 0 || event.get('participants').length > 0 ){
						shareEventOnKeeeX(event, _.union(event.get('participantsToAdd'), event.get('participants')));
						event.set('participantsToAdd', []);
					}

					if(callback){
						callback(event, false);
					}
				}
			});
		}

	});
}

/**
 * Share an event with the given list of people on keeex
 *
 * @param {calendarEvent} event - The event to share
 * @param {Array[string]} recipients - An array of idx to receive the event
 */
function shareEventOnKeeeX(event, recipients){
	if(recipients.size === 0){
		return;
	}

	kxapi.getLocations([event.get('idx')], function (err, body){
		if(err){
			// TODO : Error display
			console.error("Can't share %s - No file exist", event.get('idx'), event, recipients, err);
		}
		else{
			kxapi.share(event.get('idx'), body[0].location[0], recipients, [], function(err, body){
				if(err){
					// TODO : Error display	
					console.error("Sharing of %s failed", event.get('idx'), event, recipients, err);
				}
			});
		}
	});
}

/**
 * Fetch the latest version of a topic in KeeeX
 * The callback will be executed for **EACH** latest version (ie: when there's no next topics)
 *
 * @param {string} idx - the topic
 * @param {function} callback - A callback triggered when a latest version is found
 */
function fetchLatestVersionOfTopicInKeeex(idx, callback){
	kxapi.getNexts(idx, function(err, nexts){
		if(!err){
			if(nexts.length > 0) {
				nexts.forEach(function (item) {
					fetchLatestVersionOfTopicInKeeex(item.idx, callback);
				});
			}
			else {
				callback(idx);
			}
		}
		else{
			console.log("ERR", err);
			// TODO : Callback ?
		}
	}); 
}

/**
 * Remove the given event from the event collection
 * Mark this event as cancelled with the concept "Event cancelled" and 
 * remove it from google calendar (if connected to it)
 *
 * @param {CalendarEvent} event - The event to remove
 */
function deleteEventInKeeex(event){
	CalendarEventList.remove(event);

	kxapi.makeRef("reference", event.get('idx'), KEEEX_EVENT_CANCELLED_IDX, function(err, res){

		// Force resharing, so participants we'll have the new ref marking the event deletion
		shareEventOnKeeeX(event, event.get('participants'));

		if(gCal && event.get('gCalId') !== null){
			removeEventInGCal(event.get('gCalId'));
		}
	});
}


/**
 * Parse the event containing the data imported from KeeeX to extract the date & time of the event
 *
 * @param {CalendarEvent} event - The event to update with the parsed informations
 * @param {object} keeexTopic - The KeeeX topic to extract the informations from
 */
function parseEventDataFromKeeex(event, keeexTopic){
	var eventText = keeexTopic.description || "";

	// Event tagged with info by the calendar. We take this data
	var res = eventText.match(/KXstart (.*) (AM|PM)(.*)KXend (.*) (AM|PM)/gi);
	if(res){
		eventText = res[0];
	}
	// No tag, so we'll parse the whole text to detect any time markers inside
	else {
		eventText = keeexTopic.name + " || " + keeexTopic.description;
	}

	var result = extractTimeAndDateFromText(eventText, moment(event.get('creationDate')));
	event.set('start', result.start);
	event.set('end', result.end);
}

/**
 *	Generate the time tag to be append to the description while keeexing an event
 *
 * @param {moment} startTime - Start time of the event
 * @param {moment} endTime - End time of the event
 * @return {String} The time tag to append
 */
function getKeeexEventTimeTag(startTime, endTime){
	return "\n\nKXStart : " + startTime.format('LLLL') + "\nKXEnd : " + endTime.format('LLLL'); 
}

/**
 * Remove a time tag of a given text 
 *
 * @param {String} text - Text input to remove the timetag
 * @return {String} Text with no time tag
 */
function removeTimeTag(text){
	return text.replace(/(\s)*KX(start|end) (.*) (AM|PM)(\s)*/gi, '');
}


//////////////////////////////////////////////
//  		   Google functions				//
//////////////////////////////////////////////

/**
 * Initiate login on the Google Calendar API
 */
function signInWithGoogle(){
	GOOGLEAPIS_SCOPES = ['https://www.googleapis.com/auth/calendar'];
	GOOGLEAPIS_TOKEN_DIR = KEEEX_PATH + '/plugins/calendar.data/';
	GOOGLEAPIS_TOKEN_PATH = GOOGLEAPIS_TOKEN_DIR + 'googlecalendar-'+  keeexUserInfo.profileIdx.substring(0,11) +'.json';


	fs.readFile('googleApisClientSecret.json', function processClientSecrets(err, content) {
		if (err) {
			console.log('Error loading client secret file: ' + err);
			return;
		}

		// Authorize a client with the loaded credentials, then call the
		// Google Calendar API.
		googleAuthorize(JSON.parse(content), validateGoogleAuth);
	});
}

/**
 * Create an OAuth2 client with the given credentials, and then execute the
 * given callback function.
 *
 * @param {Object} credentials - The authorization client credentials.
 * @param {function} callback - The callback to call with the authorized client.
 */
function googleAuthorize(credentials, callback) {
	var clientSecret = credentials.installed.client_secret;
	var clientId = credentials.installed.client_id;
	var redirectUrl = credentials.installed.redirect_uris[0];
	var auth = new googleAuth();
	var oauth2Client = new auth.OAuth2(clientId, clientSecret, redirectUrl);

	// Check if we have previously stored a token.
 	fs.readFile(GOOGLEAPIS_TOKEN_PATH, function(err, token) {
		if (err) {
			getOAuthNewToken(oauth2Client, callback);
		} else {
			oauth2Client.credentials = JSON.parse(token);
			callback(oauth2Client);
		}
 	 });
}

/**
 * Get and store new token after prompting for user authorization, and then
 * execute the given callback with the authorized OAuth2 client.
 *
 * @param {google.auth.OAuth2} oauth2Client - The OAuth2 client to get token for.
 * @param {getEventsCallback} callback - The callback to call with the authorized client
 */
function getOAuthNewToken(oauth2Client, callback) {
	var authUrl = oauth2Client.generateAuthUrl({
		access_type: 'offline',
		scope: GOOGLEAPIS_SCOPES
	});

	// TODO : Hide the url bar
	var authWindow = gui.Window.open(authUrl);
	authWindow.on('loaded', function() {

		if(authWindow.window.location.pathname == "/o/oauth2/approval"){
			if(authWindow.window.document.getElementById("access_denied")){
				authWindow.close();
				console.log("ACCESS DENIED...");
				popover("Connexion refused");
			}
			else {
				var code = authWindow.window.document.getElementById("code").value;
				authWindow.close();

				oauth2Client.getToken(code, function(err, token) {
					if (err) {
						popover('Error while connectiong to your Google account...');
						console.log('Google error while getting token', err);
						return;
					}
					oauth2Client.credentials = token;
					storeOAuthToken(token);
					callback(oauth2Client);
				});
			}
		}
	});
}

/**
 * Store token to disk be used in later program executions.
 *
 * @param {Object} token - The token to store to disk.
 */
function storeOAuthToken(token) {
	try {
		fs.mkdirSync(GOOGLEAPIS_TOKEN_DIR);
	} catch (err) {
		if (err.code != 'EEXIST') {
			throw err;
		}
 	}

	fs.writeFile(GOOGLEAPIS_TOKEN_PATH, JSON.stringify(token));
	console.log('Token stored to ' + GOOGLEAPIS_TOKEN_PATH);
}

/**
 * Called at the end of Google API Auth.
 * Hide the login button and display a dialog to announce that login was sucessfull
 *
 * @param {google.auth.OAuth2} oauth2Client - The OAuth2 client
 */
function validateGoogleAuth(oauth2Client){
	document.getElementById('btn_google').disabled = true;
	popover('Connexion réussie');

	gCal = google.calendar({version:'v3', auth: oauth2Client});
	updateCalendarData();
}

/**
 * If connected to google calendar, It will fetch all future events.
 * Unknown events will be added, Known events will be updated if neeeded
 *
 * @param {function} callback (Optional) - A callback to call after the update
 */
function fetchEventsFromGCal(callback) {
	if(gCal === undefined){
		if(callback){
			callback();
		}

		return;
	}

	// Get 10 more events since last time
	// It helps to rate limit the number of imported events to not overwhelm KeeeX and Google Calendar API
	if(googleMaxResult < 500){
		googleMaxResult += 10;
	}

	// We need to force the upper limit time of sync if doesn't go forward since last update
	// meaning that there's no more events in the future in the Google Calendar, but we still might have some in keeex
	// waiting to be pushed to GCal.
	if(maxTimeDidNotChanged){
		// TODO : This could be better ^^'
		googleMaxTimeSync.add(5, 'days');
	}
	
	maxTimeDidNotChanged = true;
	console.log("Gathering data from Google Calendar - Events between now and " + googleMaxTimeSync.format());
	gCal.events.list({
		calendarId: 'primary',
		singleEvents: true,
		orderBy: 'startTime',
		timeMin: moment().format(),
		maxResults: googleMaxResult
		}, 
		function(err, response) {
			if (err){
				console.log('The google API returned an error: ' + err);
				callback();
				return;
			}

			var gEvents = response.items;
			if (gEvents.length === 0) {
				console.log('No upcoming gEvents found.');
				callback();
			} 
			else {
				console.log("fetched " + gEvents.length + "events");
				async.eachSeries(gEvents, function(gEvent, callbackAsync){

					// HOTFIX : Disable full day event
					if(gEvent.start.date !== undefined && moment(gEvent.start.date).hours() === 0){
						console.log("Ignoring full day event");
						callbackAsync();
						return;
					}

					if(googleMaxTimeSync.isBefore(gEvent.start.dateTime)){
						googleMaxTimeSync = moment(gEvent.start.dateTime);
						maxTimeDidNotChanged = false;
					}

					var idx = isThisGCalEventOnKeeex(gEvent);
					if(idx){
						var event = CalendarEventList.findWhere({idx: idx});

						if(event){
							event.set('gCalId', gEvent.id, {silent:true});

							// The idx referenced in the gcal event is the latest version. Now we check if it still matches google calendar event informations			
							if(!isThisGCalEventUpToDate(gEvent, event)){
								console.log('%s -- Update keeex data from gcal.', gEvent.summary);
								updateEventFromGCal(gEvent, event, callbackAsync);
							}
							else {
								callbackAsync();
							}
						} 
						else {
							// The idx in the gcal event is not in the event collection. Meaning that's an old version.
							// We need to find the new one and update the google calendar version.
							console.log('%s -- unknown idx.', gEvent.summary);

							fetchLatestVersionOfTopicInKeeex(idx, function (latestidx){
								console.log("fetchLatestVersionOfTopicInKeeex done");
								event = CalendarEventList.findWhere({idx: latestidx});

								if(event === undefined){
									// It's the latest, but still not in our event collection (not tagged with event or tagged with event cancelled)
									// => We need to remove it from google calendar
									removeEventInGCal(gEvent.id, callbackAsync);

								}
								else {
									// Event found, we update the event in the google calendar
									event.set('gCalId', gEvent.id);
									updateEventInGCal(event, callbackAsync);
								}	
							});
						}
					}
					else {
						console.log('%s -- Untracked event. Will be keeexed.', gEvent.summary);
						createEventFromGCal(gEvent, callbackAsync);

					}
				}, function(err){
					console.log("---- handled all events from GC");

					if(callback){
						callback();
					}
				});
			}
		});
}

/**
 * Check if the given google cal event exist in KeeeX
 * (by checking if the event description contains "keeex IDX xeeek")
 * If yes, it will return the idx found. If no, it will return false
 *
 * @param {Object} gEvent - the google calendar event
 * @return {String} - The idx found (or false if not)
 */
function isThisGCalEventOnKeeex(gEvent){
	if(gEvent.description !== undefined) {
		var res = /keeex ((?:[a-z]{5}-?){17}) xeeek/.exec(gEvent.description);
		if(res){
			return res[1];
		}
		else{
			return false;
		}
	}
	else {
		return false;
	}
}

/**
 * Check if the google calendar event matches the event referenced in KeeeX
 *
 * @param {Object} gEvent - the google calendar event
 * @param {CalendarEvent} event - the known event that was refered by the google calendar event
 */
function isThisGCalEventUpToDate(gEvent, event){

	if(!moment(gEvent.start.dateTime).isSame(event.get('start'))){
		console.log('Start time changed', event ,gEvent.start.dateTime, event.get('start'));
		return false;
	}

	if(!moment(gEvent.end.dateTime).isSame(event.get('end'))){
		console.log('End time changed', event ,gEvent.end.dateTime, event.get('end'));
		return false;
	}
	
	if(gEvent.summary.trim() != event.get('name')){
		console.log('Event summary changed', gEvent.summary, event.get('name'));
		return false;
	}

	if(gEvent.description !== undefined) {
		if(event.get('description').trim() != removeKeeeXTag(gEvent.description).trim()){
			console.log('Event description changed', gEvent.description, event.get('description'));
			return false;
		}

	}

	return true;
}

/**
 * Create an event from a google calendar event. Save it in keeex
 * It will add the topic id from KeeeX in the gCal event to avoid duplication
 *
 * @param {Object} gEvent - the google calendar event
 * @param {function} callback (Optional) - A callback to call after the save
 */
function createEventFromGCal(gEvent, callback){
	e = new CalendarEvent();

	e.set('gCalId', gEvent.id);
	e.set('name', gEvent.summary.trim() || "No name event");
	e.set('description', ( (gEvent.description !== undefined )? gEvent.description.trim() : ""));
	e.set('location', "");
	e.set('start', moment(gEvent.start.dateTime));
	e.set('end', moment(gEvent.end.dateTime));
	e.set('creationDate', moment(gEvent.created));
	e.set('participants', []);
	e.toRemove = false;

	e.save(callback);
	CalendarEventList.add(e);
}

/**
 * Create the given event into google calendar.
 * It will add in the description the idx of the event to avoid event duplication
 *
 * @param {CalendarEvent} event - The event to add in google calendar
 * @param {function} callback (Optional) - A callback to call
 */
function createEventInGCal(event, callback){
	var gEvent = {};
	gEvent.start = {};
	gEvent.end = {};

	gEvent.summary = event.get('name').trim();
	gEvent.description = event.get('description').trim() + "\nkeeex " + event.get('idx') + " xeeek";
	gEvent.start.dateTime = event.get('start').toISOString();
	gEvent.end.dateTime = event.get('end').toISOString();

	gCal.events.insert({calendarId: 'primary', resource:gEvent}, function(err, gEvent){
		if(!err){
			event.set('gCalId', gEvent.id);

			if(callback){
				callback();
			}
		}
		else {
			console.log("Could not create event on Google Calendar :<", err, gEvent, event);
			popover("Could not create event on Google Calendar :<");

			if(callback){
				callback();
			}
		}
	});
}

/**
 * Update the given event with the event coming from google calendar
 * It will add in the description the time tag for
 *
 * @param {CalendarEvent} event - The event to add in google calendar
 * @param {function} callback (Optional) - A callback to call after the save
 */
function updateEventFromGCal(gEvent, event, callback){
	event.set('name', gEvent.summary.trim() || "No name event");
	event.set('description', ( (gEvent.description !== undefined )? removeKeeeXTag(gEvent.description).trim() : ""));
	event.set('start', moment(gEvent.start.dateTime));
	event.set('end', moment(gEvent.end.dateTime));

	event.save(callback);
}

/**
 * Update the given event into google calendar.
 * It will add in the description the idx of the event to avoid event duplication
 *
 * @param {CalendarEvent} event - The event to update in google calendar
 * @param {function} callback (Optional) - A callback to call after the update
 */
function updateEventInGCal(event, callback){
	var gEvent = {};
	gEvent.start = {};
	gEvent.end = {};

	gEvent.summary = event.get('name');
	gEvent.description = event.get('description').trim() + "\nkeeex " + event.get('idx') + " xeeek";
	gEvent.start.dateTime = event.get('start').toISOString();
	gEvent.end.dateTime = event.get('end').toISOString();

	gCal.events.patch({calendarId: 'primary', eventId: event.get('gCalId'), resource:gEvent}, function(){
		if(callback){
			callback();
		}
	});
}

/**
 * Walk through the list of events to check if they need to be added in google calendar (because they don't have a gCalId)
 * To make sure it wont send too much request in one shot, it will send only 20 events max and only future events.
 *
 * @param {function} callback (Optional) - A callback to call after the update
 */
function pushEventsToGCal(callback){
	if(gCal) {

		// List future events unpushed to google calendar
		var eventsToPushToGoogle = CalendarEventList.filter(function(c){
			return moment(c.get('start')).isAfter(moment()) && c.get('gCalId') === null && moment(c.get('start')).isBefore(googleMaxTimeSync);

		});
			
		if (eventsToPushToGoogle.length > 0) {
			console.log("Pushing events to Google Calendar - " + eventsToPushToGoogle.length + "events to push - Will only push " + Math.min(20, eventsToPushToGoogle.length));
			console.log(eventsToPushToGoogle);

			for(var i = 0; i < Math.min(20, eventsToPushToGoogle.length); i++){
				createEventInGCal(eventsToPushToGoogle[i]);
			}
		}
		else {
			console.log('No event to push to Google Calendar');
		}
	}

	if(callback){
		callback();
	}
}

/**
 * Remove the given event from google calendar
 *
 * @param {String} gEventId - The gCal id of the event to remove
 * @param {function} callback (Optional) - A callback to call after the deletion
 */
function removeEventInGCal(gEventId, callback){
	if(gCal){
		gCal.events.delete({calendarId: 'primary', eventId: gEventId}, function(){
			if(callback){
				callback();
			}
		});
	}
}

/**
 * Remove the pattern (keeex IDX xeeek) used to have a reference of the idx in the given text
 *
 * @param {String} text - A text that contain the pattern
 * @return {String} - the same text without the pattern
 */
function removeKeeeXTag(text){
	return text.replace(/(\s)*keeex ((?:[a-z]{5}-?){17}) xeeek(\s)*/gi, '');
}


//////////////////////////////////////////////
//  		Common display functions		//
//////////////////////////////////////////////


/**
 * Fill the popup with the event details for the given component (ie: a block on the timeline)
 *
 * @param {DOM Object} component - the DOM element to show the popup around
 * @param {CalendarEvent} event - the event to show the informations
 */
function showEventDetail(component, event, overCalendar) {
	setVisible(document.getElementById('div_timeLineEventDetails'), true);

	var elt_rect;
	if(overCalendar){
		elt_rect = document.getElementById('div_calendar').getBoundingClientRect();
		document.getElementById('div_timeLineEventDetails').setAttribute('style', 'left : ' + (elt_rect.left) + "px; top : " + (elt_rect.top) + "px; width : " + (elt_rect.width - 44) + "px; height : " + (elt_rect.height - 44 ) + "px; border-color: " + colors(event.get('idx')));
	} else {
		elt_rect = document.getElementById('div_eventTimeLine').getBoundingClientRect();
		document.getElementById('div_timeLineEventDetails').setAttribute('style', 'left : ' + (elt_rect.left) + "px; top : " + (elt_rect.top) + "px; width : " + (elt_rect.width - 44) + "px; height : " + (elt_rect.height - 44 ) + "px; border-color: " + colors(event.get('idx')));
	}

	document.getElementById('div_timeLineEventDetailsEventName').innerHTML = event.get('name');
	document.getElementById('div_timeLineEventDetailsDescription').innerHTML = event.get('description');
	document.getElementById('span_timeLineEventDetailsIDX').innerHTML = event.get('idx').substring(0,11);

	if(event.get('start').isSame(event.get('end'), 'day')){
		// Same day event, display the day name only once
		document.getElementById('span_timeLineEventDetailsdate').innerHTML = event.get('start').format('ddd D MMM, HH:mm') + " - " + event.get('end').format('HH:mm');
	}
	else {
		// Not same day, so we display days
		document.getElementById('span_timeLineEventDetailsdate').innerHTML = event.get('start').format('ddd D MMM, HH:mm') + " - " + event.get('end').format('ddd D MMM, HH:mm');
	}

	$('#span_timeLineEventDetailsAvatar').empty();
	if (event.get('participants') && event.get('participants').length > 0) {
		event.get('participants').forEach(function (userIdx) {
			var user = EventParticipantList.findWhere({idx: userIdx});
			var avatar_url = user.get('avatar');

			// Display participants images
			var img = document.createElement('img');
			img.setAttribute('class', 'detail_avatar');
			if(user.get('avatar'))
				img.setAttribute('src', user.get('avatar'));
			else
				img.setAttribute('src', "./images/default-avatar.png");

			img.setAttribute('alt', user.get('name'));
			document.getElementById('span_timeLineEventDetailsAvatar').appendChild(img);
		});
	}
	else {
		document.getElementById('span_timeLineEventDetailsAvatar').innerHTML = "None";
	}
}


/**
 * Hide the details popup
 */
function hideEventDetail() {
	setVisible(document.getElementById('div_timeLineEventDetails'), false);
}


//////////////////////////////////////////////
//  		Event timeline functions		//
//////////////////////////////////////////////

/**
 * Initialize the event timeline display
 */
function initEventTimeLine() {
	var div_eventTimeLine = document.getElementById('div_eventTimeLine');
	var width = div_eventTimeLine.clientWidth;
	var height = div_eventTimeLine.clientHeight;
	var img_timelineNow = document.getElementById('img_timelineNow');

	img_timelineNow.addEventListener('click', function () {
		updateEventTimeLine(true);
	});

	div_eventTimeLine.addEventListener('mousedown', eventTimeLineMouseDown);
	div_eventTimeLine.addEventListener('mousemove', eventTimeLineMouseDrag);
	div_eventTimeLine.addEventListener('mouseup', eventTimeLineMouseUp);

	div_eventTimeLine.addEventListener('touchstart', eventTimeLineTouchStart);
	div_eventTimeLine.addEventListener('touchmove', eventTimeLineTouchMove);
	div_eventTimeLine.addEventListener('touchend', eventTimeLineMouseUp);

	svg_TimeLine = d3.select('#div_eventTimeLine').append('svg');

	timeLabels = svg_TimeLine.append('svg').selectAll('svg.timeLabel');
	eventLabels = svg_TimeLine.append('svg').selectAll('svg.eventLabel');

	// Timeline bar background
	svg_TimeLine.append('rect')
		.attr('class', 'timelinebar')
		.attr('x', 0)
		.attr('y', 30)
		.attr('width', width)
		.attr('height', 30);

	// Time label left
	timeLabelLeft = svg_TimeLine.append('svg')
		.attr('id', 'timeLabelLeft')
		.attr('x', 50)
		.attr('y', 50);
	timeLabelLeft
		.append('rect')
		.attr('x', -50)
		.attr('y', -20)
		.attr('width', 100)
		.attr('height', 30);
	timeLabelLeft
		.append('text')
		.attr('x', 0)
		.attr('y', 0)
		.style('text-anchor', 'middle')
		.style('fill', 'white')
		.style('font-size', 18)
		.style('font-weight', 'bold');

	// Time label right
	timeLabelRight = svg_TimeLine.append('svg')
		.attr('id', 'timeLabelRight')
		.attr('x', width - 50)
		.attr('y', 50);
	timeLabelRight
		.append('rect')
		.attr('x', -50)
		.attr('y', -20)
		.attr('width', 100)
		.attr('height', 30);
	timeLabelRight
		.append('text')
		.attr('x', 0)
		.attr('y', 0)
		.style('text-anchor', 'middle')
		.style('fill', 'white')
		.style('font-weight', 'bold')
		.style('font-size', 17);
}

/**
 * Update the event time line display
 *
 * @param {bool} autospot - Move the timeline to the current date and time if true. False by default
 */
function updateEventTimeLine(autoSpot) {
	var div_eventTimeLine = document.getElementById('div_eventTimeLine');
	var width = div_eventTimeLine.clientWidth;
	var height = div_eventTimeLine.clientHeight;
	var img_timelineNow = document.getElementById('img_timelineNow');
	var trueNow = moment();

	// Compute events position if needed
	if(needComputeEventLevels){
		timeLineLevelsAjust();
	}

	zoomPosition = width / 2;
	if (autoSpot !== undefined && autoSpot) {
		currentSelectedDate = moment();
	}

	svg_TimeLine
		.attr('width', width)
		.attr('height', height);

	svg_TimeLine.select('line.liveline')
		.attr('x1', zoomPosition)
		.attr('y1', img_timelineNow.clientHeight)
		.attr('x2', zoomPosition)
		.attr('y2', height);

	svg_TimeLine.select('rect.timelinebar')
		.attr('width', width);

	var img_nowOffsetPosisition = (moment(trueNow).diff(currentSelectedDate).valueOf() * zoomGap / zoomTimeDistance[zoomLevel] + zoomPosition);
	img_nowOffsetPosisition = img_nowOffsetPosisition < 0 ? 0 : (img_nowOffsetPosisition > width ? width : img_nowOffsetPosisition);
	img_timelineNow.setAttribute('style', 'left : ' + (img_nowOffsetPosisition - img_timelineNow.clientWidth / 2) + 'px; top : 0px');
	
	// Calculate number of available timelabel
	var timeLabelNumber = Math.round(width / zoomGap) + 2;
	if (timeLabelNumber % 2) timeLabelNumber += 1;

	var midNight = moment(currentSelectedDate).startOf('day');
	var diff = currentSelectedDate.valueOf() - midNight.valueOf();
	var nearest = Math.floor(diff / zoomTimeDistance[zoomLevel]);
	var startLabel = nearest - timeLabelNumber / 2;
	var endLabel = nearest + timeLabelNumber / 2;

	var timeData = [];
	for (var i = startLabel; i < endLabel; i++) {
		timeData.push({ 'id': zoomLevel + "" + i, order: i });
	}

	timeLabels = timeLabels.data(timeData, function (d) { /*//console.log(d.id);*/ return d.id; });

	timeLabels.exit()
		.transition()
		.duration(100)
		.style('opacity', 0)
		.remove();

	var svg = timeLabels.enter()
		.append('svg')
		.attr('class', 'timeLabel')
		.style('opacity', 1)
		.attr('x', function (d) {
			return ((moment(midNight.valueOf() + d.order * zoomTimeDistance[zoomLevel])).valueOf() - currentSelectedDate.valueOf()) / zoomTimeDistance[zoomLevel] * zoomGap + zoomPosition;
		})
		.attr('y', 50);
	svg.append('line')
		.attr('x1', 0)
		.attr('y1', 5)
		.attr('x2', 0)
		.attr('y2', 10)
		.attr('stroke', "red")
		.attr('stroke-width', 1);
	svg.append('line')
		.attr('x1', 0)
		.attr('y1', 10)
		.attr('x2', 0)
		.attr('y2', height)
		.attr('stroke', "#ecf0f1")
		.attr('stroke-width', 1);
	svg.append('text')
		.attr('x', 0)
		.attr('y', 0)
		.style('text-anchor', 'middle')
		.text(function (d) {
			var current = moment(midNight.valueOf() + d.order * zoomTimeDistance[zoomLevel]);
			switch (zoomLevel) {
				case 0:
					if (current.minutes() === 0) return current.hours() + 'h';
					else return current.hours() + ":" + current.minutes();
					break;
				case 1:
					if (current.minutes() === 0) return current.hours() + 'h';
					else return current.hours() + ":" + current.minutes();
					break;
				case 2:
					return current.hours() + "h";
				case 3:
					return current.date() + " - " + current.hours() + "h";
				default:
					return "0";
			}
		})
		.style('font-weight', function (d) {
			if ((d.order * zoomTimeDistance[zoomLevel]) % 3600000 === 0)
				return 'bold';
			else
				return '';
		})
		.style('font-size', function (d) {
			if ((d.order * zoomTimeDistance[zoomLevel]) % 3600000 === 0)
				return 16;
			else
				return 12;
		});

	svg.selectAll('*')
		.style('opacity', 0)
		.transition()
		.delay(100)
		.duration(200)
		.style('opacity', 1);

	timeLabels.select('text')
		.style('font-weight', function (d) {
			if ((d.order * zoomTimeDistance[zoomLevel]) % 3600000 === 0)
				return 'bold';
			else
				return '';
		})
		.style('font-size', function (d) {
			if ((d.order * zoomTimeDistance[zoomLevel]) % 3600000 === 0)
				return 14;
			else
				return 10;
		})
		.text(function (d) {
			var current = moment(midNight.valueOf() + d.order * zoomTimeDistance[zoomLevel]);
			switch (zoomLevel) {
				case 0:
					if (current.minutes() === 0) return current.hours() + 'h';
					else return current.hours() + ":" + current.minutes();
					break;
				case 1:
					if (current.minutes() === 0) return current.hours() + 'h';
					else return current.hours() + ":" + current.minutes();
					break;
				case 2:
					return current.hours() + "h";
				case 3:
					if(current.hours() === 0) return current.date();
					else return current.hours() + "h";
					break;
				default:
					return "0";
			}
		});

	timeLabels.transition()
		.delay(0)
		.duration(0)
		.attr('x', function (d) {
			return (midNight.valueOf() + d.order * zoomTimeDistance[zoomLevel] - currentSelectedDate.valueOf()) / zoomTimeDistance[zoomLevel] * zoomGap + zoomPosition;
		});

	// Left label
	timeLabelLeft.select('text')
		.text(function () {
			var current = moment(midNight.valueOf() + (startLabel + 2) * zoomTimeDistance[zoomLevel]);
			switch (zoomLevel) {
				case 0:
					return current.hours() + "h";
				case 1:
				case 2:
					return current.format('MMM') + " " + current.date();
				case 3:
					return current.format('MMM') + " " + current.year();
				default:
					return "0";
			}
		});

	// Right label
	timeLabelRight
		.attr('x', width - 50);
	timeLabelRight.select('text')
		.text(function () {
			var current = moment(midNight.valueOf() + (endLabel - 2) * zoomTimeDistance[zoomLevel]);
			switch (zoomLevel) {
				case 0:
					return current.hours() + "h";
				case 1:
				case 2:
					return current.format('MMM') + " " + current.date();
				case 3:
					return current.format('MMM') + " " + current.year();
				default:
					return "0";
			}
		});



	// Now we display the events
	var iEventStack = CalendarEventList.toArray();

	eventLabels.remove();
	eventLabels = svg_TimeLine.append('svg').selectAll('svg.eventLabel');

	eventLabels = eventLabels.data(iEventStack, function (d) {return d.get('idx'); });
	eventLabels.exit().remove();

	eventLabels.transition()
		.delay(0)
		.duration(0)
		.attr('x', function (d) {
			return (d.get('start') - currentSelectedDate.valueOf()) / zoomTimeDistance[zoomLevel] * zoomGap + zoomPosition;
		})
		.attr('y', function (d) { return marginTop + (d.get('level') * 2 + 1) * (height - marginTop) / (numberOfEventLevel * 2 + 1);})
		.attr('width', function (d) { return ((d.get('end') - d.get('start')) / zoomTimeDistance[zoomLevel] * zoomGap) < 5 ? 5 : (d.get('end') - d.get('start')) / zoomTimeDistance[zoomLevel] * zoomGap; })
		.attr('height', function (d) { return (height - marginTop) / (numberOfEventLevel * 2 + 1); });

	var event = eventLabels.enter().append('svg')
		.attr('class', 'eventLabel')
		.attr('x', function (d) {
			return (d.get('start') - currentSelectedDate.valueOf()) / zoomTimeDistance[zoomLevel] * zoomGap + zoomPosition;
		}).attr('y', function (d) { return marginTop + (d.get('level') * 2 + 1) * (height - marginTop) / (numberOfEventLevel * 2 + 1);})
		.attr('width', function (d) { return ((d.get('end') - d.get('start')) / zoomTimeDistance[zoomLevel] * zoomGap) < 5 ? 5 : (d.get('end') - d.get('start')) / zoomTimeDistance[zoomLevel] * zoomGap; })
		.attr('height', function (d) { return (height - marginTop) / (numberOfEventLevel * 2 + 1); });

	event.append('rect')
		.attr('width', '100%')
		.attr('height', '100%')
		.on('mouseover', function (d) {
			showEventDetail(this, d, true);
		})
		.on('mouseout', function (d) {
			hideEventDetail();
		})
		.on('click', function(d){
			var menu = new gui.Menu();
			var menuitem_edit = new gui.MenuItem({ label: 'Edit' });
			var menuitem_share = new gui.MenuItem({ label: 'Share' });
			var menuitem_delete = new gui.MenuItem({ label: 'Delete' });

			// Add some items
			menu.append(menuitem_edit);
			menu.append(menuitem_share);
			menu.append(menuitem_delete);

			menuitem_edit.click = function() { 
				openUpdateDialog(CalendarEventList.get(d));
			};

			menuitem_share.click = function() { 
				openShareDialog(CalendarEventList.get(d));
			};

			menuitem_delete.click = function() { 
				deleteEventInKeeex(CalendarEventList.get(d));
			};

			menu.popup(d3.event.clientX, d3.event.clientY);
			return false;
		})
		.attr('class',  function (d) { 
			 return ((moment().isAfter(d.get('end'))) ? "oldEvent" : "" ); })
		.style('fill', function (d) { return colors(d.get('idx')); });


	var fo = event.append("foreignObject")
		.attr('width', '100%')
		.attr('height', '100%')
		.on('mouseover', function (d) {
			showEventDetail(this, d, true);
		})
		.on('mouseout', function (d) {
			hideEventDetail();
		})
		.on('click', function(d){
			var menu = new gui.Menu();
			var menuitem_edit = new gui.MenuItem({ label: 'Edit' });
			var menuitem_share = new gui.MenuItem({ label: 'Share' });
			var menuitem_delete = new gui.MenuItem({ label: 'Delete' });

			// Add some items
			menu.append(menuitem_edit);
			menu.append(menuitem_share);
			menu.append(menuitem_delete);

			menuitem_edit.click = function() { 
				openUpdateDialog(CalendarEventList.get(d));
			};

			menuitem_share.click = function() { 
				openShareDialog(CalendarEventList.get(d));
			};

			menuitem_delete.click = function() { 
				deleteEventInKeeex(CalendarEventList.get(d));
			};

			menu.popup(d3.event.clientX, d3.event.clientY);
			return false;
		})
		.on('dblclick', function(d){
			//alert('lol');
		})
		.attr('style', 'vertical-align: middle; font-family: OpenSans; font-size: 13px; text-align:center;') // STYLE FIX ME : Text not vertically centered
		.text(function (d) { return d.get('name'); });

	d3.selectAll(document.getElementsByTagName('foreignObject'))
		.style('visibility', function () {
			return (this.parentNode.getAttribute('width') > 50) ? "visible" : "hidden";
		});

}

/**
 * Calculate the "level" (aka y position) of each events on the time line to make sure none will overlap
 */
function timeLineLevelsAjust() {
	numberOfEventLevel = 0;
	var stack = [];
	
	CalendarEventList.forEach(function (e) {
		var levelFound = -1;
		for (var i = 0; i < numberOfEventLevel; i++) {
			if (stack[i] !== undefined && stack[i].length === 0) {
				levelFound = i;
				break;
			}
			else {
				if (e.get('start') > stack[i][stack[i].length - 1].get('end')) {
					levelFound = i;
				}
				else {
					continue;
				}
			}
		}
		if (levelFound == -1) {
			levelFound = numberOfEventLevel;
			numberOfEventLevel++;
		}

		e.set('level', levelFound, {silent:true});

		if (!stack[levelFound]) {
			stack.push([]);
		}
		stack[levelFound].push(e);
	});
}


/**
 * Event handler for the MouseDown event.
 * Record the event and set the parameters for draggging
 *
 * @param {DOMEvent} event - The mouse down event
 */
function eventTimeLineMouseDown(event) {
	isMouseDown = true;
	startX = event.clientX;
	oldNow = currentSelectedDate;
}

/**
 * Event handler for the MouseDrag event.
 * Calculate the time dragging and draw trhe timeline accordingly
 *
 * @param {DOMEvent} event - The mouse down event
 */
function eventTimeLineMouseDrag(event) {
	if (isMouseDown) {
		endX = event.clientX;
		autoSpot = false;
		currentSelectedDate = moment(oldNow.valueOf() - (endX - startX) * zoomTimeDistance[zoomLevel] / zoomGap);

		updateEventTimeLine(false);
	}
}

/**
 * Event handler for the TouchStart event.
 * Record the event and set the parameters for draggging
 *
 * @param {DOMEvent} event - The mouse down event
 */
function eventTimeLineTouchStart(event) {
	isMouseDown = true;
	startX = event.touches[0].clientX;
	oldNow = currentSelectedDate;
}

/**
 * Event handler for the TouchMove event.
 * Calculate the time dragging and draw trhe timeline accordingly
 *
 * @param {DOMEvent} event - The mouse down event
 */
function eventTimeLineTouchMove(event) {
	if (isMouseDown) {
		endX = event.touches[0].clientX;
		autoSpot = false;
		currentSelectedDate = moment(oldNow.valueOf() - (endX - startX) * zoomTimeDistance[zoomLevel] / zoomGap);

		updateEventTimeLine(false);
	}
}

/**
 * Event handler for the MouseUP / TouchEnd event.
 *
 * @param {DOMEvent} event - The mouse down event
 */
function eventTimeLineMouseUp(event) {
	isMouseDown = false;
}


//////////////////////////////////////////////
//			  Event list functions			//
//////////////////////////////////////////////

/**
 * Updates the event list displayed on the left
 */
function updateEventListView() {
	var showTodayEvents = document.getElementById('cb_eventListToday').checked;
	var showUpcomingEvents = document.getElementById('cb_eventListUpcoming').checked;
	var showAllEvents = document.getElementById('cb_eventListAll').checked;
	var trueNow = moment();

	// Today's events display
	setVisible(document.getElementById('div_eventListTodayContainer'), showTodayEvents);
	if(showTodayEvents) {
		var div_eventListToday = document.getElementById('div_eventListToday');

		// Fetch all events from today
		var eventToday = CalendarEventList.filter(function(c){
			return moment(c.get('start')).isSame(trueNow, 'day');
		});
		
		// Display them
		if (eventToday.length > 0) {
			$(div_eventListToday).empty();
			eventToday.forEach(function(event){
				div_eventListToday.appendChild(createEventListItem(event));
			});
		}
		else {
			div_eventListToday.innerHTML = "No event";
		}
	}

	// Upcomming events (not those today) display
	setVisible(document.getElementById('div_eventListUpcomingContainer'), showUpcomingEvents);
	if (showUpcomingEvents) {
		var div_eventListUpcoming = document.getElementById('div_eventListUpcoming');

		// Fetch all events after today
		var eventUp = CalendarEventList.filter(function(c){
			return moment(c.get('start')).isAfter(trueNow, 'day');
		});

		// Display them
		if (eventUp.length > 0) {
			$(div_eventListUpcoming).empty();
			eventUp.forEach(function(event){
				div_eventListUpcoming.appendChild(createEventListItem(event));
			});
		}
		else {
			div_eventListUpcoming.innerHTML = "No event";
		}
	}

	// All events display
	setVisible(document.getElementById('div_eventListAllContainer'), showAllEvents);
	if (showAllEvents) {
		var div_eventListAll = document.getElementById('div_eventListAll');

		// Display all events
		if (CalendarEventList.length > 0) {
			$(div_eventListAll).empty();
			CalendarEventList.forEach(function (event){
				div_eventListAll.appendChild(createEventListItem(event));
			});
		}
		else {
			div_eventListAll.innerHTML = "No event";
		}
	}
}

/**
 * Create and return a DOM object containing informations about the given event to be displayed in the event list
 *
 * @param {CalendarEvent} event - The event to display
 * Return : A DOM object
 */
function createEventListItem(event) {
	var divContainer = document.createElement('div');
	var divTitle = document.createElement('div');
	var divTime = document.createElement('div');
	var divIdx = document.createElement('div');

	divContainer.setAttribute('class', 'event_item ' + ( (moment().isAfter(event.get('end'))) ? "oldEvent" : "" ) );
	divContainer.setAttribute('style', 'background-color:' + colors(event.get('idx')));
	divContainer.momentValue = event.get('start');
	divContainer.addEventListener('click', function (evt) {
		if (evt.target.momentValue) {
			currentSelectedDate = moment(evt.target.momentValue);
			updateEventTimeLine(false);
			updateUI();
		}
	});

	divTitle.setAttribute('class', 'event_item_title');
	divTitle.innerHTML = event.get('name');
	divIdx.setAttribute('class', 'event_item_idx');
	divIdx.innerHTML = removeNewLines(event.get('description')).substring(0, 20) + ((removeNewLines(event.get('description')).length > 20) ?"..." : "");

	divTime.setAttribute('class', 'event_item_time');
	divTime.innerHTML = resolveTime(event.get('start'), event.get('end'));

	divContainer.appendChild(divTitle);
	divContainer.appendChild(divIdx);
	divContainer.appendChild(divTime);

	return divContainer;
}


//////////////////////////////////////////////
//		   Event calendar functions			//
//////////////////////////////////////////////

/**
 * Init the calendary view (Show day names and register click events for buttons)
 */
function initCalendar() {
	for(var j = 1; j < 8; j++){
		var div = document.createElement('div');
		div.setAttribute('class', 'calendarDayName');
		div.innerHTML = moment().day(j).format('dddd');
		document.getElementById('div_calendarDayNames').appendChild(div);
	}

	// Register click event "Today" button
	document.getElementById('btn_calendarNow').addEventListener('click', function () {
		currentSelectedDate = moment().hours(13).minutes(0);
		updateUI();
	});

	// Register click event on "Previous month" button
	document.getElementById('btn_calendarPrevMonth').addEventListener('click', function () {
		currentSelectedDate.subtract(1, 'months');
		updateUI();
	});

	// Register click event on "Next month" button
	document.getElementById('btn_calendarNextMonth').addEventListener('click', function () {
		currentSelectedDate.add(1, 'months');
		updateUI();
	});
}

/**
 * Updates the calendar view to display the given moment
 */
function showCalendarAt() {
	var today = moment();
	var fistMonthDay = moment(currentSelectedDate).startOf('month');

	// Calcultate the distance in days between the start of calendar (wich is a Monday) with the starting day of the month
	var distance = fistMonthDay.day() - 1;
	if(distance < 0){
		distance += 7;
	}

	// Empty the calendar
	$('#div_calendarContent').empty();
	
	// Fill the calendar
	for (var i = 0; i < 42; i++) {
		var div_dayContainer = document.createElement('div');
		var div_daycontainerDate = document.createElement('div');
		var div_dayContainerBody = document.createElement('div');

		var d = moment(fistMonthDay).add(i-distance, 'days');											    //      HERE HERE      \\
																										   //vvvvvvvvvvvvvvvvvvvvvvv\\
		div_dayContainer.setAttribute('class', 'date' + ((!d.isSame(fistMonthDay, 'month')) ? " disabled" : ((d.isSame(currentSelectedDate, 'day')) ? " selected" : "")));
		div_dayContainer.setAttribute('style', 'left: ' + (1 + 14 * (i % 7)) + "%; top:" + (2 + 16 * Math.floor(i / 7)) + "%; width: 14%; height: 16%;");

		c = moment(d).add(13, 'hours');
		div_dayContainerBody.momentValue = c;
		div_dayContainerBody.addEventListener('click', eventClickOnCalendarDay);

		// Highlight the current day
		div_daycontainerDate.setAttribute('class', 'date_date' + ((d.isSame(today, 'day')) ? " today" : ""));
		div_daycontainerDate.innerHTML = d.date().toString();

		div_dayContainerBody.setAttribute('class', 'date_body');

		// Grab the events of the current day
		var eventsOfTheDay = CalendarEventList.getEventOfday(d);

		if (eventsOfTheDay.length > 0) {
			var divBulletContainer = document.createElement('div');
			divBulletContainer.setAttribute('class', 'event_bullet');

			for (var j = 0; j < eventsOfTheDay.length; j++) {
				divBulletContainer.appendChild(calendarDisplayEvent(eventsOfTheDay[j]));
			}

			div_dayContainerBody.appendChild(divBulletContainer);
		}

		div_dayContainer.appendChild(div_dayContainerBody);
		div_dayContainer.appendChild(div_daycontainerDate);

		div_dayContainer.addEventListener('contextmenu', leftClickOnCalendarDay);

		document.getElementById('div_calendarContent').appendChild(div_dayContainer);
	}

	document.getElementById('div_calendarMonthYearDisplay').innerHTML = currentSelectedDate.format('MMMM') + " " + currentSelectedDate.year();
}

/**
 * Handle left clic DOM event on a day.
 * Allows to create a new event on this day
 *
 * @param {DOMEvent} evt - The mouse down event
 */
 function leftClickOnCalendarDay(evt) { 
	evt.preventDefault();
	var menu = new gui.Menu();
	var menuitem_create = new gui.MenuItem({ label: 'Create an event here' });

	// Add some items
	menu.append(menuitem_create);

	menuitem_create.click = function () { 
		showDialogNewEvent(null, evt.target.momentValue);
	};

	menu.popup(evt.x, evt.y);
	return false;
} 


/**
 * Handle clic DOM event on a day.
 * Turn the focus on this day and center the timeline over it
 *
 * @param {DOMEvent} evt - The mouse down event
 */
function eventClickOnCalendarDay (evt) {
	if (evt.target.momentValue) {
		currentSelectedDate = evt.target.momentValue;
		
		showCalendarAt();
		updateEventTimeLine(false);
	}
}

/**
 * Create and return a DOM object containing informations about the given event to be displayed in the calendar
 *
 * @param {CalendarEvent} anEvent - The event to display
 * Return : A DOM object reprenting the event bubble to be added on the day
 */
function calendarDisplayEvent(anEvent) {
	var divBulletItem = document.createElement('div');

	divBulletItem.setAttribute('style', 'background-color : ' + colors(anEvent.get('idx')));
	divBulletItem.setAttribute('class', 'event_bullet_item ' + ( (moment().isAfter(anEvent.get('end'))) ? "oldEvent" : "" ));
	divBulletItem.eventID = anEvent.cid;

	// Click => "focus" on event (ie timeline)
	divBulletItem.addEventListener('click', function (evt) {
		currentSelectedDate = moment(CalendarEventList.get(evt.target.eventID).get('start'));
		updateUI();
	});

	// Mouse over => Display event informations (like on the timeline)
	divBulletItem.addEventListener('mouseover', function (evt) {
		showEventDetail(evt.target, CalendarEventList.get(evt.target.eventID));
	});

	// Mouse out => Hide the informations
	divBulletItem.addEventListener('mouseout', function (d) {
		hideEventDetail();
	});

	// Right click : Context menu
	divBulletItem.addEventListener('contextmenu', function(evt) { 
		evt.preventDefault();
		evt.stopPropagation();

		var menu = new gui.Menu();
		var menuitem_edit = new gui.MenuItem({ label: 'Edit' });
		var menuitem_share = new gui.MenuItem({ label: 'Share' });
		var menuitem_delete = new gui.MenuItem({ label: 'Delete' });

		// Add some items
		menu.append(menuitem_edit);
		menu.append(menuitem_share);
		menu.append(menuitem_delete);

		menuitem_edit.click = function() { 
			openUpdateDialog(CalendarEventList.get(evt.target.eventID));
		};

		menuitem_share.click = function() { 
			openShareDialog(CalendarEventList.get(evt.target.eventID));
		};

		menuitem_delete.click = function() { 
			deleteEventInKeeex(CalendarEventList.get(evt.target.eventID));
		};

		menu.popup(evt.x, evt.y);
		return false;
	});

	return divBulletItem;
}


//////////////////////////////////////////////
//			   Dialog functions				//
//////////////////////////////////////////////


////////////////////////////////////////////// Dialog create event

/**
 * Activated when the user use paste when there's no event creation dialog.
 * If the clipboard contains text, it opens the event creation dialog, fills the description with the clipboard data 
 * and parse the text to pre-fill the time inputs for the event
 *
 * @param {DOM Event} evt The paste event
 */
function createNewEventFromClipboard(evt){
	if (evt.clipboardData && evt.clipboardData.getData) {
        var pastedText = evt.clipboardData.getData('text/plain');
        if(pastedText !== ""){
        	showDialogNewEvent(pastedText);
        }
    }
}

/* 
 * Open the dialog form to create a new event.
 * If a content is specified, it will be put in the description textarea and parsed to extract time and pre-fill the time input
 *
 * @param {String} content (optional) - A description for the event
 * @param {moment} startDateProposal (optional) - Proposal of a start date (end date will be start +1hour)
 */
function showDialogNewEvent(content, startDateProposal) {
	// Disallow pasting event
	document.getElementsByTagName('body')[0].removeEventListener("paste", createNewEventFromClipboard);

	// Clean the form
	document.getElementById('input_eventTitle').value = "";
	document.getElementById('input_eventDescription').value = (typeof content === "string") ? content : "";
	document.getElementById('input_eventID').value = "";

	// Set the dialog title
	document.getElementById('div_createEditEventDialogTitle').innerHTML = "Create an event";

	// Hide the "Shared with..."
	setVisible(document.getElementById('bigDialog_sharedTo'), false);

	// Show all contacts with a checkbox to select them for sharing
	new participantListViewChecklist({ el: $("#bigDialog_shareWith") }).render();

	// TODO : ICI
	if(typeof content === "string"){
		var parsedTime = extractTimeAndDateFromText(content, moment());
		document.getElementById('input_eventStartDate').value = parsedTime.start.format('YYYY/MM/DD');
		document.getElementById('input_eventStartTime').value = parsedTime.start.format('HH:mm');
		document.getElementById('input_eventEndDate').value = parsedTime.end.format('YYYY/MM/DD');
		document.getElementById('input_eventEndTime').value = parsedTime.end.format('HH:mm');
	}
	else if(moment.isMoment(startDateProposal)){
		document.getElementById('input_eventStartDate').value = startDateProposal.format('YYYY/MM/DD');
		document.getElementById('input_eventStartTime').value = startDateProposal.format('HH:mm');
		startDateProposal.add(1, 'hours');
		document.getElementById('input_eventEndDate').value = startDateProposal.format('YYYY/MM/DD');
		document.getElementById('input_eventEndTime').value = startDateProposal.format('HH:mm');
	}
	else {
		document.getElementById('input_eventStartDate').value = moment().format('YYYY/MM/DD');
		document.getElementById('input_eventStartTime').value = moment().format('HH:00');
		document.getElementById('input_eventEndDate').value = moment().format('YYYY/MM/DD');
		document.getElementById('input_eventEndTime').value = moment().add(1,'hour').format('HH:00');
	}

	// Setup the actions for each buttons
	document.getElementById('btn_createEditEventDialogOK').addEventListener('click', OkButtonNewEvent);
	document.getElementById('btn_createEditEventDialogCancel').addEventListener('click', CancelButtonNewEvent);

	window.onkeydown = function( event ) {
	    if ( event.keyCode === 27 ) {
	    	CancelButtonNewEvent();
	    }
	};

	// Display the dialog
	setVisible(document.getElementById('div_hider'), true);
	setVisible(document.getElementById('div_createEditEventDialog'), true);
}

/**
 * Triggered when user click on OK in the creation dialog.
 * Initiate event creation
 */
function OkButtonNewEvent() {
	startTime = moment(document.getElementById('input_eventStartDate').value + ' ' + document.getElementById('input_eventStartTime').value, 'YYYY/MM/DD HH:mm');
	endTime = moment(document.getElementById('input_eventEndDate').value + ' ' + document.getElementById('input_eventEndTime').value, 'YYYY/MM/DD HH:mm');
	title = document.getElementById('input_eventTitle').value;

	// Some checks first
	if(title === ""){
		alert("An event should have a name");
		return;
	}

	if(!startTime.isValid()){
		alert("Invalid event start date");
		return;
	}

	if(!endTime.isValid()){
		alert("Invalid event end date");
		return;
	}

	if(endTime.isBefore(startTime)){
		alert("The event can end only be after it has started");
		return;
	}

	// Allow creating an event with pasting again
	document.getElementsByTagName('body')[0].addEventListener("paste", createNewEventFromClipboard, false);

	// Hide the dialog
	setVisible(document.getElementById('div_createEditEventDialog'), false);
	setVisible(document.getElementById('div_hider'), false);

	// Unregister clic events on buttons
	document.getElementById('btn_createEditEventDialogOK').removeEventListener('click', OkButtonNewEvent);
	document.getElementById('btn_createEditEventDialogCancel').removeEventListener('click', CancelButtonNewEvent);

	// Unregister keydown event (esc press)
	window.onkeydown = null;	

	// Fetch users to share the newly created event
	var chk_arr = EventParticipantList.where({checked: true});
	var recipients = [];
	for (var i = 0; i < chk_arr.length; i++) {
		recipients.push(chk_arr[i].get('idx'));
	}

	// Create the new event with the name and description given
	createNewEvent(document.getElementById('input_eventTitle').value, 
				   document.getElementById('input_eventDescription').value,
				   startTime,
				   endTime,
				   recipients);
}

/**
 * Triggered when user click on cancel in the creation dialog.
 * Cancel event creation
 */
function CancelButtonNewEvent() {
	// Allow creating an event with pasting again
	document.getElementsByTagName('body')[0].addEventListener("paste", createNewEventFromClipboard, false);

	// Hide the dialog
	setVisible(document.getElementById('div_createEditEventDialog'), false);
	setVisible(document.getElementById('div_hider'), false);

	// Unregister click events on button
	document.getElementById('btn_createEditEventDialogOK').removeEventListener('click', OkButtonNewEvent);
	document.getElementById('btn_createEditEventDialogCancel').removeEventListener('click', CancelButtonNewEvent);

	// Unregister keydown event (esc press)
	window.onkeydown = null;
}


////////////////////////////////////////////// Dialog edit event

/** 
 * Open the dialog form to edit an event
 *
 * @param {CalendarEvent} event the event that will be edited through the edit dialog
 */
function openUpdateDialog(event){
	// Disallow pasting event
	document.getElementsByTagName('body')[0].removeEventListener("paste", createNewEventFromClipboard);

	// Set the dialog title
	document.getElementById('div_createEditEventDialogTitle').innerHTML = "Edit an event";

	// Fill the form
	document.getElementById('input_eventTitle').value = event.get('name');
	document.getElementById('input_eventDescription').value = event.get('description');
	document.getElementById('input_eventID').value = event.cid;
	document.getElementById('input_eventStartDate').value = event.get('start').format('YYYY/MM/DD');
	document.getElementById('input_eventStartTime').value = event.get('start').format('HH:mm');
	document.getElementById('input_eventEndDate').value = event.get('end').format('YYYY/MM/DD');
	document.getElementById('input_eventEndTime').value = event.get('end').format('HH:mm');

	// Show people participating in the event
	setVisible(document.getElementById('bigDialog_sharedTo'), true);
	$('#bigDialog_shared').empty();
	if (event.get('participants') && event.get('participants').length > 0) {
		event.get('participants').forEach(function (userIdx) {
			var user = EventParticipantList.findWhere({idx: userIdx});
			var avatar_url = user.get('avatar');

			// Display participants images
			var img = document.createElement('img');
			img.setAttribute('class', 'detail_avatar');
			if(user.get('avatar'))
				img.setAttribute('src', user.get('avatar'));
			else
				img.setAttribute('src', "./images/default-avatar.png");

			img.setAttribute('alt', user.get('name'));
			img.setAttribute('title', user.get('name'));
			document.getElementById('bigDialog_shared').appendChild(img);
		});
	}

	// Show all contacts with a checkbox to select them for sharing - 
	new participantListViewChecklist({ el: $("#bigDialog_shareWith"), container_id: 'div_createEditEventDialog' }).render();

	// Register action buttons
	document.getElementById('btn_createEditEventDialogOK').addEventListener('click', OkButtonEditEvent);
	document.getElementById('btn_createEditEventDialogCancel').addEventListener('click', CancelButtonEditEvent);

	window.onkeydown = function( event ) {
	    if ( event.keyCode === 27 ) {
	    	CancelButtonEditEvent();
	    }
	};

	// Display the dialog
	setVisible(document.getElementById('div_hider'), true);
	setVisible(document.getElementById('div_createEditEventDialog'), true);
}

/**
 * Triggered when user click on OK in the creation dialog.
 * Initiate event modification
 */
function OkButtonEditEvent() {
	startTime = moment(document.getElementById('input_eventStartDate').value + ' ' + document.getElementById('input_eventStartTime').value, 'YYYY/MM/DD HH:mm');
	endTime = moment(document.getElementById('input_eventEndDate').value + ' ' + document.getElementById('input_eventEndTime').value, 'YYYY/MM/DD HH:mm');
	title = document.getElementById('input_eventTitle').value;

	// Let's do some checks first
	if(title === ""){
		alert("An event should have a name");
		return;
	}

	if(!startTime.isValid()){
		alert("Invalid event start date");
		return;
	}

	if(!endTime.isValid()){
		alert("Invalid event end date");
		return;
	}

	if(endTime.isBefore(startTime)){
		alert("The event can end only be after it has started");
		return;
	}


	// Allow creating an event with pasting again
	document.getElementsByTagName('body')[0].addEventListener("paste", createNewEventFromClipboard, false);

	// Hide the dialog
	setVisible(document.getElementById('div_createEditEventDialog'), false);
	setVisible(document.getElementById('div_hider'), false);

	// Unregister click events on button
	document.getElementById('btn_createEditEventDialogOK').removeEventListener('click', OkButtonEditEvent);
	document.getElementById('btn_createEditEventDialogCancel').removeEventListener('click', CancelButtonEditEvent);

	// Unregister keydown event (esc press)
	window.onkeydown = null;

	// Fetch users to share the newly created event
	var chk_arr = EventParticipantList.where({checked: true});
	var recipients = [];
	for (var i = 0; i < chk_arr.length; i++) {
		recipients.push(chk_arr[i].get('idx'));
	}

	// Go, edit the event!
	editEvent(CalendarEventList.get(document.getElementById('input_eventID').value), 
			  title, 
			  document.getElementById('input_eventDescription').value,
			  startTime,
			  endTime,
			  recipients);
}


/**
 * Triggered when user click on  cancel in the creation dialog.
 * Cancel event modification
 */
function CancelButtonEditEvent() {

	// Allow creating an event with pasting again
	document.getElementsByTagName('body')[0].addEventListener("paste", createNewEventFromClipboard, false);

	// Hide the dialog
	setVisible(document.getElementById('div_createEditEventDialog'), false);
	setVisible(document.getElementById('div_hider'), false);

	// Unregister click events on button
	document.getElementById('btn_createEditEventDialogOK').removeEventListener('click', OkButtonEditEvent);
	document.getElementById('btn_createEditEventDialogCancel').removeEventListener('click', CancelButtonEditEvent);

	// Unregister keydown event (esc press)
	window.onkeydown = null;

}

////////////////////////////////////////////// Dialog shares event

/** 
 * Open a dialog to share an event
 *
 * @param {CalendarEvent} event - The event that will be shared through the share dialog
 */
function openShareDialog(event){
	document.getElementById('btn_shareEventDialogOK').addEventListener('click', OkButtonShareEvent);
	document.getElementById('btn_shareEventDialogCancel').addEventListener('click', CancelButtonShareEvent);

	window.onkeydown = function( event ) {
	    if ( event.keyCode === 27 ) {
	    	CancelButtonShareEvent();
	    }
	};

	document.getElementById('span_shareEventName').innerHTML = event.get('name');
	document.getElementById('input_shareEventID').value = event.cid;

	// Show people participating in the event
	document.getElementById('div_shareEventCurrentParticipants').innerHTML = "";
	if (event.get('participants') && event.get('participants').length > 0) {
		event.get('participants').forEach(function (userIdx) {
			var user = EventParticipantList.findWhere({idx: userIdx});
			var avatar_url = user.get('avatar');

			// Display participants images
			var img = document.createElement('img');
			img.setAttribute('class', 'detail_avatar');
			if(user.get('avatar'))
				img.setAttribute('src', user.get('avatar'));
			else
				img.setAttribute('src', "./images/default-avatar.png");

			img.setAttribute('alt', user.get('name'));
			img.setAttribute('title', user.get('name'));
			document.getElementById('div_shareEventCurrentParticipants').appendChild(img);
		});
	}

	// Show all other contact that arent participating with a checkbox to select them for sharing
	new participantListViewChecklist({ el: $("#div_shareEventDialogContent") }).render();


	// Display the dialog
	setVisible(document.getElementById('div_hider'), true);
	setVisible(document.getElementById('div_shareEventDialog'), true);
}

/**
 * Triggered when user click on OK in the share dialog.
 * Initiate event sharing
 */
function OkButtonShareEvent() {
	// Hide the dialog
	setVisible(document.getElementById('div_shareEventDialog'), false);
	setVisible(document.getElementById('div_hider'), false);

	// Unregister click events on button
	document.getElementById('btn_shareEventDialogOK').removeEventListener('click', OkButtonShareEvent);
	document.getElementById('btn_shareEventDialogCancel').removeEventListener('click', CancelButtonShareEvent);

	// Unregister keydown event (esc press)
	window.onkeydown = null;

	var chk_arr = EventParticipantList.where({checked: true});
	var recipients = [];
	for (var i = 0; i < chk_arr.length; i++) {
		recipients.push(chk_arr[i].get('idx'));
	}

	shareEventOnKeeeX(CalendarEventList.get(document.getElementById('input_shareEventID').value), recipients);
}


/**
 * Triggered when user click on cancel in the creation dialog.
 * Cancel event modification
 */
function CancelButtonShareEvent() {
	// Hide the dialog
	setVisible(document.getElementById('div_shareEventDialog'), false);
	setVisible(document.getElementById('div_hider'), false);

	// Unregister click events on button
	document.getElementById('btn_shareEventDialogOK').removeEventListener('click', OkButtonShareEvent);
	document.getElementById('btn_shareEventDialogCancel').removeEventListener('click', CancelButtonShareEvent);

	// Unregister keydown event (esc press)
	window.onkeydown = null;

}


////////////////////////////////////////////// Dialog popover

/** 
 * Open an popover dialog with the given message. The callback will be executed when the user clicks "ok"
 *
 * @param {string} message - The message to display
 * @param {function} callback - The function to call after the user acknowleged the message by clicking "ok" 
 */
function popover(message, callback) {
	var div_hider = document.getElementById('div_hider');
	setVisible(div_hider, true);

	var divDialog = document.getElementById('div_dialog');
	var divDialogTitleBar = document.getElementById('div_dialogTitleBar');
	var divDialogContent = document.getElementById('div_dialogContent');
	var btDialogOK = document.getElementById('btn_dialogOK');
	var btDialogCancel = document.getElementById('btn_dialogCancel');

	setVisible(btDialogOK, true);
	btDialogCancel.setAttribute('style', 'display : none');
	divDialogTitleBar.innerHTML = "Information";
	divDialogContent.innerHTML = message;
	btDialogOK.addEventListener('click', function _func(evt) {
		setVisible(btDialogOK, false);
		setVisible(divDialog, false);
		setVisible(div_hider, false);
		btDialogOK.removeEventListener('click', _func);
		if (typeof callback === "function") 
			callback();

	});
	setVisible(divDialog, true);
}


/* 
 * Open an unclickable popover dialog with the given message.
 *
 * @param {string} message The message to display
 */
function unclickable_popover(message, callback) {
	var div_hider = document.getElementById('div_hider');
	setVisible(div_hider, true);

	var divDialog = document.getElementById('div_dialog');
	var divDialogTitleBar = document.getElementById('div_dialogTitleBar');
	var divDialogContent = document.getElementById('div_dialogContent');
	var btDialogOK = document.getElementById('btn_dialogOK');
	var btDialogCancel = document.getElementById('btn_dialogCancel');

	setVisible(btDialogOK, false);
	btDialogCancel.setAttribute('style', 'display : none');
	divDialogTitleBar.innerHTML = "Info";
	divDialogContent.innerHTML = message;
	setVisible(divDialog, true);
}


//////////////////////////////////////////////
//			  Utility functions				//
//////////////////////////////////////////////

/**
 * Display the time remaing before the event or the time past after.
 * Also display "now" during the event
 *
 * @param {Moment} dateStart the moment the event start
 * @param {Moment} dateEnd the moment the event end
 * @return {String} the time before or after it.
 */ 
function resolveTime(dateStart, dateEnd) {
	if (moment().isBetween(dateStart, dateEnd))
		return "Now";
	else {
		if(moment().isBefore(dateStart)){
			return dateStart.fromNow();
		}
		else {
			return dateEnd.fromNow();
		}
		
	}
}

/**
 * Change the visibility of the given element
 *
 * @param {DOM Object} element The element to change the visibility
 * @param {visible} visible Wether if we display or not the element
 */
function setVisible(element, visible) {
	if (visible)
		element.setAttribute('style', 'visibility : visible');
	else
		element.setAttribute('style', 'display : none');
}

/**
 * Transforms <br/> into \n
 *
 * @param {String} str The string containing <br />
 * @return {String} The string with <br /> replaced by \n
 */
function br2nl(str) {
    return str.replace(/<br\s*\/?>/mg,"\n");
}

function removeNewLines(str){
	return str.replace(/<br\s*\/?>/mg," ");
}

