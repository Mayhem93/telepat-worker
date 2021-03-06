var args = require('electron').argv();
var async = require('async');
var redis = require('redis');
require('colors');

var Models = require('telepat-models');

var workerType = args.params.t;
var workerIndex = args.params.i;
/**
 *
 * @type {Base_Worker}
 */
var theWorker = null;
var configManager = null;

async.series([
	function(callback) {
		configManager = new Models.ConfigurationManager('./config.spec.json', './config.json');
		configManager.load(function(err) {
			if (err) return callback(err);

			var testResult = configManager.test();
			callback(testResult !== true ? testResult : undefined);
		});
	},
	function(callback) {
		switch (workerType) {
			case 'aggregation':	{
				var AggregationWorker = require('./lib/aggregation_worker');
				theWorker = new AggregationWorker(workerIndex, configManager.config);

				break;
			}
			case 'write': {
				var WriterWorker = require('./lib/writer_worker');
				theWorker = new WriterWorker(workerIndex, configManager.config);

				break;
			}
			case 'transport_manager': {
				var TransportManagerWorker = require('./lib/transport_manager');
				theWorker = new TransportManagerWorker(workerIndex, configManager.config);

				break;
			}
			default: {
				var workerTypeParts = workerType.split('_');
				if (workerTypeParts[1] === 'transport') {
					var ClientTransportWorker = require('./lib/client_transport/'+workerTypeParts[0]);
					theWorker = new ClientTransportWorker(workerIndex, configManager.config);
				} else {
					console.log('Invalid worker type "'+workerType+'"');
					process.exit(1);
				}
			}
		}
		callback();
	},
	function(callback) {
		theWorker.config.subscribe_limit = theWorker.config.subscribe_limit || 64;
		theWorker.config.get_limit = theWorker.config.get_limit || 384;

		if (theWorker.config.logger) {
			theWorker.config.logger.name = theWorker.name;
			Models.Application.logger = new Models.TelepatLogger(theWorker.config.logger);
		} else {
			Models.Application.logger = new Models.TelepatLogger({
				type: 'Console',
				name: theWorker.name,
				settings: {level: 'info'}
			});
		}

		if (!Models[theWorker.config.main_database]) {
			Models.Application.logger.emergency('Unable to load "'+theWorker.config.main_database+
				'" main database: not found. Aborting...');
			process.exit(2);
		}

		Models.Application.datasource = new Models.Datasource();
		Models.Application.datasource.setMainDatabase(new Models[theWorker.config.main_database](theWorker.config[theWorker.config.main_database]));

		callback();
	},
	function(callback) {
		Models.Application.datasource.dataStorage.onReady(function() {
			callback();
		});
	},
	function(callback) {
		if (Models.Application.redisClient)
			Models.Application.redisClient = null;

		Models.Application.redisClient = redis.createClient(theWorker.config.redis.port, theWorker.config.redis.host);
		Models.Application.redisClient.on('error', function(err) {
			Models.Application.logger.error('Failed connecting to Redis "'+
				theWorker.config.redis.host+'": '+err.message+'. Retrying...');
		});
		Models.Application.redisClient.on('ready', function() {
			Models.Application.logger.info('Client connected to Redis.');
			callback();
		});
	},
	function(callback) {
		if (Models.Application.redisCacheClient)
			Models.Application.redisCacheClient = null;

		Models.Application.redisCacheClient = redis.createClient(theWorker.config.redisCache.port, theWorker.config.redisCache.host);
		Models.Application.redisCacheClient.on('error', function(err) {
			Models.Application.logger.error('Failed connecting to Redis Cache "'+theWorker.config.redisCache.host+'": '+
				err.message+'. Retrying...');
		});
		Models.Application.redisCacheClient.on('ready', function() {
			Models.Application.logger.info('Client connected to Redis Cache.');
			callback();
		});
	},
	function(callback) {
		if (!Models[theWorker.config.message_queue]) {
			Models.Application.logger.emergency('Unable to load "'+theWorker.config.message_queue+
				'" messaging queue: not found. Aborting...');
			process.exit(-1);
		}

		var messageQueueConfig = theWorker.config[theWorker.config.message_queue];

		if (messageQueueConfig === undefined) {
			messageQueueConfig = {broadcast: theWorker.broadcast, exclusive: theWorker.exclusive};
		} else {
			messageQueueConfig.broadcast = theWorker.broadcast;
			messageQueueConfig.exclusive = theWorker.exclusive;
		}

		var messagingClient = new Models[theWorker.config.message_queue](messageQueueConfig, theWorker.name, workerType);
		theWorker.messagingClient = messagingClient;

		messagingClient.onReady(callback);
	}
], function(err) {
	if (err) {
		throw err;
	}
	theWorker.ready();
});
