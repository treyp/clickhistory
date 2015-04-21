// Third-party modules
var express = require('express');
var app = express();
var request = require('request');
var WebSocket = require('ws');
var moment = require('moment');
var pg = require('pg');

// Middleware and Express settings
app.disable('x-powered-by'); // Remove Express's HTTP header

// Use gzip compression on requests:
// http://www.senchalabs.org/connect/compress.html
app.use(require('compression')());

app.get('/', function (req, res) {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "X-Requested-With");
    res.json(entries);
});

var server = app.listen(process.env.PORT || 8001, function () {
    console.log('App listening on port %s', server.address().port);
});

var entries = [];

var buttonURL = 'http://www.reddit.com/r/thebutton';

var flairClass = function (seconds) {
    if (seconds > 51) {
        return "flair-press-6";
    }
    if (seconds > 41) {
        return "flair-press-5";
    }
    if (seconds > 31) {
        return "flair-press-4";
    }
    if (seconds > 21) {
        return "flair-press-3";
    }
    if (seconds > 11) {
        return "flair-press-2";
    }
    return "flair-press-1";
};

var addTime = function (seconds, clicks) {
    entries = entries.slice(0, process.env.MAX_ENTRIES || 1e3).concat({
        seconds: seconds,
        time: moment().valueOf(),
        color: flairClass(seconds),
        clicks: clicks
    });
};

var setupWebSocket = function (websocketUrl) {
    var currentParticipants;
    var previousSecondsLeft;
    var previousParticipants;

    console.log('Setting up WebSocket...');
    var socket = new WebSocket(websocketUrl);
    socket.on('close', function () {
        console.log('WebSocket closed. Searching for a new URL...');
        setTimeout(findWebSocket, 0);
    });
    socket.on('message', function (data) {
        /*
        sample tick data:
        {
            "type": "ticking",
            "payload": {
                "participants_text": "608,802",
                "tick_mac": "50e7a9fd2e4c8feae6851884f91d65908cceb06b",
                "seconds_left": 60.0,
                "now_str": "2015-04-06-04-08-07"
            }
        }
        */
        var packet = JSON.parse(data);
        if (packet.type !== "ticking") {
            return;
        }
        var tick = packet.payload;

        currentParticipants = parseInt(
            tick.participants_text.replace(/,/g, ""),
            10
        );

        if (previousParticipants &&
            previousParticipants < currentParticipants) {
            // the second argument calculates how many people
            // clicked this time. multiple clicks apparently all count for
            // the same number.
            addTime(
                previousSecondsLeft,
                (currentParticipants - previousParticipants)
            );
        }

        previousSecondsLeft = tick.seconds_left;
        previousParticipants = currentParticipants;
    });
    socket.on('open', function () {
        console.log('Listening to the WebSocket messages.');
    });
};

var findWebSocket = function () {
    console.log('Finding WebSocket URL...');
    request(buttonURL, function (error, response, body) {
        if (error || response.statusCode !== 200) {
            console.log('Reddit server error. Trying again in five seconds.');
            setTimeout(findWebSocket, 5e3);
        }
        var regex = /"(wss:\/\/[^"]+)/g;
        var matches = regex.exec(body);
        if (matches && matches[1]) {
            console.log('WebSocket URL found: ', matches[1]);
            setupWebSocket(matches[1]);
        } else {
            console.log('No WebSocket URL found in Reddit response. Trying again in five seconds.');
            setTimeout(findWebSocket, 5e3);
        }
    });
};

pg.connect(process.env.DATABASE_URL, function (err, client, done) {
    if (err) {
        console.error('Statup DB connection error:', err);
    }
    client.query('SELECT data FROM entry_saves WHERE id = 1;', function (err, result) {
        if (err || !result.rows.length) {
            err ? console.error('Query error:', err) : console.log('No rows of data found.');
            done(client);
            findWebSocket();
            return;
        }
        done();
        entries = result.rows[0].data;
        console.log('Found ' + entries.length + ' rows of data.');
        findWebSocket();
    });
});

var saveEntries = function (code) {
    pg.connect(process.env.DATABASE_URL, function (err, client, done) {
        if (err) {
            console.error('Shutdown DB connection error:', err);
        }
        console.log('Shutting down by ' + code + '. Saving data to DB.');
        client.query('UPDATE entry_saves SET data = $1 WHERE id = 1;', [JSON.stringify(entries)], function () {
            client.query('INSERT INTO entry_saves (id, data) SELECT 1, $1 WHERE NOT EXISTS (SELECT 1 FROM entry_saves WHERE id=1);', [JSON.stringify(entries)], function () {
                console.log('Data saved to DB.');
                process.kill(process.pid, code);
            });
        });
    });
};
process.once('SIGTERM', function () { saveEntries('SIGTERM'); });
process.once('SIGUSR2', function () { saveEntries('SIGUSR2'); });
process.once('SIGINT', function () { saveEntries('SIGINT'); });
