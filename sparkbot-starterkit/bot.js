// CiscoSpark defines 2 types of webhooks
// - REST webhook : receive all events from a Room (NewMessage is the only even supported as of v1),
//     see https://developer.ciscospark.com/webhooks-explained.html and https://developer.ciscospark.com/resource-webhooks.html
// - Outgoing integration : receive new messages from a Room, REST API not documented.
//     launch the CiscoSpark Web client, go to a Room, look for the integrations on the right panel, create a new integration

var https = require('https');
var express = require('express');
var app = express();

// use bodyParser to read data from a POST
var bodyParser = require('body-parser');
app.use(bodyParser.urlencoded({extended: true}));
app.use(bodyParser.json());


/* Starts a Cisco Spark webhook with specified configuration
 *
 *  { 
 * 		port:      		8080,						// local dev env port, optional, defaults to process.env.PORT, or 8080 	                   	
 * 		webhookURI: 	"/webhook" 					// implements a REST Webhook behavior if present
 *  	integrationURI: "/integration"   		    // implements an Outgoing integration behavior if present
 *  	healthURI : 	"/ping",  					// health URI, optional, defaults to "/ping"
 * 		token:  		"ERTCSGJTYJDSQFSDFDSFsd",   // Spark token, mandatory for REST webhook to decrypt incoming message
 *  }
 * 
 */
function Webhook(config) {
	self = this;

	self.started = Date.now();

	function execute(message) {
		if (self.handler) {
			self.handler(message);
		}
	}

	function triggerMessageCreatedEvent(originalResponse, triggerData) {
		// Check the event is well formed
		if (!triggerData.id) {
			console.log("no message id, aborting...");
			originalResponse.status(500).json({'message': 'could not retreive the message contents, no message id there !'});
			return;
		}
		var messageId = triggerData.id;

		// Retreive text for message id
		console.log("requesting message contents");
		var options = {
						'method': 'GET',
						'hostname': 'api.ciscospark.com',
						'path': '/v1/messages/' + messageId,
						'headers': {'authorization': 'Bearer ' + self.config.token}
					};
		var req = https.request(options, function (response) {
			console.log('assembling message');
			var chunks = [];
			response.on('data', function (chunk) {
				chunks.push(chunk);
			});
			response.on("end", function () {
				var payload = JSON.parse(Buffer.concat(chunks));

				if (response.statusCode != 200) {
					console.log("bad response when retreiving message with id: " + messageId);
					originalResponse.status(500).json({'message': 'bad response when retreiving the text of the message with id:' + messageId});
					return;
				}
					
				// Robustify
				var message = validateMessage(payload);
				if (!message) {
					console.log("unexpected message format, aborting...");
					// let's consider this as a satisfying situation, it is simply a message structure we do not support
					// we do not want the webhook to resend us the message again and again 
					// => 200 OK: got it and we do not process further  
					originalResponse.status(200).json({'message': 'no content to process for new message with id:' + messageId});
					return;
				}

				// event is ready to be processed, let's respond to Spark without waiting whatever the processing outcome will be
				originalResponse.status(200).json({'message': 'message is being processed by webhook'});

				// processing happens now
				//console.log("Now processing 'message/created' event");
				console.log("now processing 'message/created' event with contents: " + JSON.stringify(message)); // for debugging purpose only
				execute(message);
			});

		});
		req.on('error', function(err) {
  			console.log("cannot retreive message with id: " + messageId + ", error: " + JSON.stringify(err));
			originalResponse.status(500).json({'message': 'could not retreive the text of the message with id:' + messageId});
			return;
		});
		req.end();
	}

	if (!config) {
		// defaults the webhook to an incoming integration
		config = { integrationURI: "/integration" };
		console.log('no configuration => starting up as an incoming integration...');
	}
	self.config = config;

	// health endpoint
	var health = config.healthURI || "/ping";
	app.get(health, function (req, res) {
		res.json({
			'message': 'Congrats, your bot is up and running',
			'since': new Date(self.started).toISOString(),
			'integrationURI': config.integrationURI || null,
			'webhookURI': config.webhookURI || null,
			'processable': '[messages/created]'		// should dynamically explore the registered handlers
		});
	});

	// REST webhook handler
	if (config.webhookURI) {
		app.route(config.webhookURI)
			.get(function (req, res) {
				console.log("GET received instead of a POST");
				res.status(400).json({message: 'This REST webhook is expecting an HTTP POST'});
			})
			.post(function (req, res) {
				console.log("REST webhook invoked");

				// analyse payload
				if (!req.body || !req.body.data || !req.body.resource || !req.body.event) {
					console.log("Unexpected payload: no data, resource or event in body, aborting...");
					res.status(400).json({message: 'Wrong payload, a data+resource+event payload is expected for REST webhooks',
										  details: 'either the bot is misconfigured or Cisco Spark is running a new API version'});
					return;
				}
				var resource = req.body.resource;
				var event = req.body.event;
				var data = req.body.data;

				// take action depending on event and ressource triggered
				// see https://developer.ciscospark.com/webhooks-explained.html
				
				switch (resource) {
					case "messages":
						switch (event) {
							case "created": 
								triggerMessageCreatedEvent(res, data);
								break;

							case "deleted":
							default:
								console.log("this webhook does not support this resource/event type: messages/deleted");
								res.status(500).json({message: 'This webhook does not support this resource/event type: messages/deleted'});
								break; 
						}
						break;

					default:
						console.log("this webhook does not support this resource/event type: " + resource + "/" + event);
						res.status(500).json({message: 'This webhook does not support this resource/event type: ' + resource + '/' + event });
						break;
				}
			});
	}

	// Outgoing integration handler
	if (config.integrationURI) { 
		app.route(config.integrationURI)
			.get(function (req, res) {
				console.log("GET received instead of a POST");
				res.status(400).json({message: 'This outgoing integration is expecting an HTTP POST'});
			})
			.post(function (req, res) {
				console.log("outgoing integration invoked ");

				// Robustify: do not proceed if the paylod does not comply with the expected message structure
				var message = validateMessage(req.body)
				if (!message) {
					console.log("unexpected message format, aborting: " + message);
					// let's consider this as a satisfying situation, it is simply a message structure we do not support
					// we do not want the webhook to resend us the message again and again 
					// => 200 OK: got it and we do not process further  
					originalResponse.status(200).json({'message': 'message format is not supported'});
					return;
				}

				res.status(200).json({'message': 'message processed by integration'});

				// INTEGRATION processing
				console.log('invoking message handler: ' + JSON.stringify(message));
				execute(message);
			});
	}

	// Start bot
	var port = config.port || process.env.PORT || 8080;
	app.listen(port, function () {
		console.log('Cisco Spark bot started on port: ' + port);
	});
}


// Register the specified function to process new messages
// The function should have a function(message) signature
// Message is an object instantiated from json payloads such as :
//
//   {
//   	"id" : "46ef3f0a-e810-460c-ad37-c161adb48195",
//   	"personId" : "49465565-f6db-432f-ab41-34b15f544a36",
//   	"personEmail" : "matt@example.com",
//   	"roomId" : "24aaa2aa-3dcc-11e5-a152-fe34819cdc9a",
//   	"text" : "PROJECT UPDATE - A new project project plan has been published on Box",
//   	"files" : [ "http://www.example.com/images/media.png" ],
//   	"toPersonId" : "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9mMDZkNzFhNS0wODMzLTRmYTUtYTcyYS1jYzg5YjI1ZWVlMmX",
//   	"toPersonEmail" : "julie@example.com",
//   	"created" : "2015-10-18T14:26:16+00:00"
//   }
//
// Check https://developer.ciscospark.com/endpoint-messages-messageId-get.html for more information
Webhook.prototype.register = function(registered) {
	this.handler = function(message) {
		registered(message);
	};
}

// Returns a trigger if the payload complies with the documentation, undefined otherwise
// see https://developer.ciscospark.com/webhooks-explained.html 
//
//   {
//     "id":"Y2lzY29zcGFyazovL3VzL1dFQkhPT0svZjRlNjA1NjAtNjYwMi00ZmIwLWEyNWEtOTQ5ODgxNjA5NDk3",
//     "name":"Guild Chat to http://requestb.in/1jw0w3x1",
//     "resource":"messages",
//     "event":"created",
//     "filter":"roomId=Y2lzY29zcGFyazovL3VzL1JPT00vY2RlMWRkNDAtMmYwZC0xMWU1LWJhOWMtN2I2NTU2ZDIyMDdi",
//     "data":{
//       "id":"Y2lzY29zcGFyazovL3VzL01FU1NBR0UvMzIzZWUyZjAtOWFhZC0xMWU1LTg1YmYtMWRhZjhkNDJlZjlj",
//       "roomId":"Y2lzY29zcGFyazovL3VzL1JPT00vY2RlMWRkNDAtMmYwZC0xMWU1LWJhOWMtN2I2NTU2ZDIyMDdi",
//       "personId":"Y2lzY29zcGFyazovL3VzL1BFT1BMRS9lM2EyNjA4OC1hNmRiLTQxZjgtOTliMC1hNTEyMzkyYzAwOTg",
//       "personEmail":"person@example.com",
//       "created":"2015-12-04T17:33:56.767Z"
//     }
//   } 
function valideTrigger(payload) {
    if (!payload 	|| !payload.id 
                    || !payload.name 
                    || !payload.resource 
                    || !payload.event) {
        console.log("trigger structure is not compliant");
        return undefined;
    }
    return payload;
}

//  Returns a message if the payload complies with the documentation, undefined otherwise
//  see https://developer.ciscospark.com/endpoint-messages-messageId-get.html for more information
//   {
//   	"id" : "46ef3f0a-e810-460c-ad37-c161adb48195",
//   	"personId" : "49465565-f6db-432f-ab41-34b15f544a36",
//   	"personEmail" : "matt@example.com",
//   	"roomId" : "24aaa2aa-3dcc-11e5-a152-fe34819cdc9a",
//   	"text" : "PROJECT UPDATE - A new project project plan has been published on Box",
//   	"files" : [ "http://www.example.com/images/media.png" ],
//   	"toPersonId" : "Y2lzY29zcGFyazovL3VzL1BFT1BMRS9mMDZkNzFhNS0wODMzLTRmYTUtYTcyYS1jYzg5YjI1ZWVlMmX",
//   	"toPersonEmail" : "julie@example.com",
//   	"created" : "2015-10-18T14:26:16+00:00"
//   }
function validateMessage(payload) {
    if (!payload 	|| !payload.id 
                    || !payload.personId 
                    || !payload.personEmail 
                    || !payload.roomId  
                    || !payload.created) {
        console.log("message structure is not compliant");
        return undefined;
    }
    if (!payload.text && !payload.files) {
        console.log("message structure is not compliant: no text nor file in there");
        return undefined;
    }
    return payload;
}

module.exports = Webhook