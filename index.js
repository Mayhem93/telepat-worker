 args = require('electron').argv();
var cb = require('couchbase');
var kafka = require('kafka-node');
var async = require('async');
var sizeof = require('object-sizeof');

var Models = require('octopus-models-api');

var config = {};//require('./config.json');

if (process.env.TP_CB_HOST) {
	config.couchbase = {
		host: process.env.TP_CB_HOST,
		dataBucket: process.env.TP_CB_BUCKET,
		stateBucket: process.env.TP_CB_STATE_BUCKET,
		opIdentifiersBucket: process.env.TP_CB_OPIDENTIFIERS_BUCKET
	};
} else {
	config.couchbase = require('./config.json').couchbase;
}

if (process.env.TP_KFK_HOST) {
	config.kafka = {
		host: process.env.TP_KFK_HOST,
		port: process.env.TP_KFK_PORT,
		clientName: process.env.TP_KFK_CLIENT
	};
} else {
	config.kafka = require('./config.json').kafka;
}

var cluster = new cb.Cluster('couchbase://'+config.couchbase.host);

bucket = null;
stateBucket = null;
/*	this bucket is used to uniquely identify an operation (create/read/update/delete) so the writer doesn't
	perform the same operation multiple times
 */
opIdentifiersBucket = null;

var topics = ['aggregation', 'write', 'track', 'update_friends'];

var Aggregator = require('./lib/aggregator');
var Writer = require('./lib/writer');
var UpdateFriends = require('./lib/update_friends');

var topic = args.params.t;
var consumerIndex = args.params.i;

if (topics.indexOf(topic) === -1 && topic.slice(-9) !== 'transport') {
    console.error('Topic must be one of '+topics.toString()+' or a transport topic.');
    process.exit(-1);
}

process.title = config.kafka.clientName+'-'+topic+'-'+consumerIndex;

var kafkaClient = new kafka.Client(config.kafka.host+':'+config.kafka.port+'/', config.kafka.clientName+'-'+topic+'-'+consumerIndex);
kafkaConsumer = new kafka.HighLevelConsumer(kafkaClient, [{topic: topic}], {groupId: topic});
kafkaProducer = new kafka.HighLevelProducer(kafkaClient);

process.on('SIGUSR2', function() {
    console.log('SIGUSR2');
    bucket.disconnect();
    stateBucket.disconnect();
    opIdentifiersBucket.disconnect();
    kafkaClient.close();
});

process.on('SIGTERM', function() {
    console.log('SIGTERM');
    bucket.disconnect();
    stateBucket.disconnect();
    opIdentifiersBucket.disconnect();
    kafkaClient.close(function() {
        process.exit(-1);
    });
});

process.on('exit', function() {
    console.log('EXIT');
    if (bucket)
        bucket.disconnect();
    if (stateBucket)
        stateBucket.disconnect();
    if (opIdentifiersBucket)
        opIdentifiersBucket.disconnect();
    kafkaClient.close();
});

kafkaConsumer.on('error', function(err) {
    console.log(err);
    bucket.disconnect();
    stateBucket.disconnect();
    opIdentifiersBucket.disconnect();
    process.exit(-1);
});

var transport = null;

/**
 * Forms the key of a subscription document (only for simple filters)
 * @param appId integer Application ID
 * @param item Object Item
 * @returns string[] 5 Subscription keys (some of them but not all may be null).
 */
formKeys = function(appId, item, callback) {
	var mdl = item.type;
	var user_id = item.user_id;
	var id = item.id;

	for (var r in Models.Application.loadedAppModels[message.applicationId][mdl].belongsTo) {
		if (item[Models.Application.loadedAppModels[message.applicationId][mdl].belongsTo[r].parentModel+'_id']) {
			var parent = {model: Models.Application.loadedAppModels[message.applicationId][mdl].belongsTo[r].parentModel,
				id: item[Models.Application.loadedAppModels[message.applicationId][mdl].belongsTo[r].parentModel+'_id']};
		}
	}

	var allItemsChannelKey = 'blg:'+context+':'+Models.Application.loadedAppModels[appId][mdl].namespace;
    var userItemsChannelKey = null;
    var allChildItemsChannelKey = null;
    var userChildItemsChannelKey = null;
	var singleItemChannelKey = null;
	var result = [];

    if (user_id)
        userItemsChannelKey = allItemsChannelKey+':users:'+user_id;
    if (parent)
        allChildItemsChannelKey = allItemsChannelKey+':'+Models.Application.loadedAppModels[appId][parent.model].namespace+':'+parent.id;
    if (user_id && parent)
        userChildItemsChannelKey = userItemsChannelKey+':'+Models.Application.loadedAppModels[appId][parent.model].namespace+':'+parent.id;
	if (id)
		singleItemChannelKey = 'blg:'+Models.Application.loadedAppModels[appId][mdl].namespace+':'+id+':deltas';

	var partialKeys = [allItemsChannelKey, userItemsChannelKey, allChildItemsChannelKey, userChildItemsChannelKey, singleItemChannelKey];

    allItemsChannelKey += ':deltas';
    if (userItemsChannelKey)
        userItemsChannelKey += ':deltas';
    if (allChildItemsChannelKey)
        allChildItemsChannelKey += ':deltas';
    if (userChildItemsChannelKey)
        userChildItemsChannelKey+= ':deltas';
	if (id)
		singleItemChannelKey += ':deltas';

	result = [allItemsChannelKey, userItemsChannelKey, allChildItemsChannelKey, userChildItemsChannelKey, singleItemChannelKey];

	async.each(partialKeys, function(key, c) {
		if(key) {
			var query = stateBucket.ViewQuery.from('dev_state_document', 'by_subscription').custom({stale: false, key: '"'+key+'"'});
			stateBucket.query(query, function(err, results) {
				for(var k in results) {
					var queryObject = JSON.parse((new Buffer(results[k].value)).toString('ascii'));

					if (Models.utils.testObject(item, queryObject))
						result.push(k+':deltas');
				}
				c();
			});
		}
	}, function(err) {
		if (err) return callback(err);
		callback(null, result);
	});
};

//Open connections to databases
async.series([
    function(callback) {
        bucket = cluster.openBucket(config.couchbase.dataBucket);
        bucket.nodeConnectionTimeout = 10000;
        bucket.on('connect', callback);
        bucket.on('error', function(err) {
            console.log('Data bucket error: ', err);
            bucket.disconnect();
            process.exit(-1);
        });
    },
    function (callback) {
        stateBucket = cluster.openBucket(config.couchbase.stateBucket);
        stateBucket.nodeConnectionTimeout = 10000;
        stateBucket.on('connect', callback);
        stateBucket.on('error', function(err) {
            console.log('State bucket error: ', err);
            bucket.disconnect();
            process.exit(-1);
        });
    },
    function (callback) {
        opIdentifiersBucket = cluster.openBucket(config.couchbase.opIdentifierBucket);
        opIdentifiersBucket.nodeConnectionTimeout = 10000;
        opIdentifiersBucket.on('connect', callback);
        opIdentifiersBucket.on('error', function(err) {
            console.log('Op identifiers bucket error: ', err);
            bucket.disconnect();
            stateBucket.disconnect();
            process.exit(-1);
        });
    }
], function(err) {
    Models.Application.setBucket(bucket);
    Models.Application.setStateBucket(stateBucket);

	var topicParts = topic.split('_');
	if (topicParts[1] === 'transport') {
		var transportType = topicParts[0];
		try {
			transport = require('./lib/client_transport/' + transportType);

			if (transport.initialize) {
				transport.initialize();
			}

		} catch (e) {
			if (e.code == 'MODULE_NOT_FOUND') {
				console.error('Transport topic "'+topic+'" is not a valid transport type.');
				process.exit(-1);
			} else
				throw e;
		}
	}

	var functionSwitch = function(msgValue) {
		switch(topic) {
			case 'aggregation': {
				Aggregator(msgValue);

				break;
			}

			case 'write': {
				Writer(msgValue);

				break;
			}

			case 'update_friends': {
				UpdateFriends(msgValue);

				break;
			}

			default: {
				var topicParts = topic.split('_');
				if (topicParts[1] === 'transport') {
					transport.Send(msgValue);
				}
			}
		}
	};

	kafkaConsumer.on('message', function(message) {
        console.log(message.value);

        var msgValue = JSON.parse(message.value);

        if (sizeof(Models.Application.loadedAppModels) > (1 << 26)) {
            delete Models.Application.loadedAppModels;
            Models.Application.loadedAppModels = {};
        }

        if (!Models.Application.loadedAppModels[msgValue.applicationId]) {
            Models.Application.loadAppModels(msgValue.applicationId, function() {
				functionSwitch(msgValue);
			});
        } else
            functionSwitch(msgValue);
    });

	var packageJson = require('./package.json');

	console.log('Telepat Worker version '+packageJson.version+' initialized at '+(new Date()).toString()+'. Queue: "'+topic+'". Consumer index: '+consumerIndex);
});
