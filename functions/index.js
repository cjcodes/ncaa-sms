const functions = require('firebase-functions');
const admin = require('firebase-admin');
const phoneTool = require('phone');
const fetch = require('node-fetch');
const config = require('./config.js');
const twilio = require('twilio');
const moment = require('moment');
const stripe = require('stripe')(config.stripe.key);

admin.initializeApp(functions.config().firebase);

const SCORE_LIMIT = 10;
const MINUTES_LEFT = 10;
const HALF_STRING = '2nd Half';

function checkResults(games) {
  for (let i in games) {
    if (games[i].currentPeriod == HALF_STRING) {
      const game = games[i];
      const minutesLeft = game.timeclock.split(':')[0];
      if (minutesLeft < MINUTES_LEFT) {
        const score = Math.abs(game.home.currentScore - game.away.currentScore);
        if (score <= SCORE_LIMIT) {
          notify(game.home.shortname, game.away.shortname, score);
        }
      }
    }
  }
}

const MESSAGE = "%hTeam% v. %vTeam% is close, with only a %point% point difference in the 4th quarter!\n\nText STOP to opt out.";
function notify(home, away, score) {
  const subs = admin.database().ref('/subscriptions');
  const gameStr = home+away;

  subs.once('value', function (snapshot) {
    const users = snapshot.val();

    for (let i in users) {
      if (users[i].score >= score) {
        if (!users[i].games || users[i].games.indexOf(gameStr) == -1) {
          const message = MESSAGE
            .replace('%hTeam%', home)
            .replace('%vTeam%', away)
            .replace('%point%', score);

          sendMessage(i, message);
          saveGame(i, gameStr);
        }
      }
    }
  });
}

function saveGame(user, game) {
  admin.database().ref('/subscriptions/'+user+'/games').once('value', function (snapshot) {
    let games = snapshot.val();
    if (games === null) {
      games = [];
    }
    games.push(game);
    snapshot.ref.set(games);
  });
}

function sendMessage(number, message) {
  var client = new twilio.RestClient(config.twilio.sid, config.twilio.token);

  client.messages.create({
    body: message,
    to: number,
    messagingServiceSid: config.twilio.copilotId,
  }, function (err, message) {
    console.log(err);
    console.log(message);
  });
}

exports.cron = functions.https.onRequest((req, res) => {
  const dateFormat = 'MM/DD';
  const m = moment();

  const today = m.clone().format(dateFormat);
  const yesterday = m.clone().subtract(1, 'days').format(dateFormat);
  const tomorrow = m.clone().add(1, 'days').format(dateFormat);

  const BASE_URL = 'http://data.ncaa.com/jsonp/scoreboard/basketball-men/d1/2017/%s/scoreboard.html';
  const URLs = [
    BASE_URL.replace('%s', yesterday),
    BASE_URL.replace('%s', today),
    BASE_URL.replace('%s', tomorrow),
  ];

  URLs.map(function (URL) {
    fetch(URL)
      .then(data => data.text())
      .then(text => text.replace('callbackWrapper(', '').replace('});', '}'))
      .then(text => JSON.parse(text))
      .then(json => {
        checkResults(json.scoreboard[0].games);
      })
      .catch(e => {
      });
  });

  res.send('Done!');
});

exports.subscribe = functions.https.onRequest((req, res) => {
  res.header('Access-Control-Allow-Origin', '*');

  const phone = phoneTool(req.body.phone);
  const number = phone[0];
  const country = phone[1];
  const score = req.body.score;

  if (score > SCORE_LIMIT) {
    res.status(500).send('In order to try to not spam you too much, we\'ve limited the maximum score difference to '+SCORE_LIMIT+'.');
    return;
  }

  if (country !== 'USA') {
    console.log('Attempted registration from: ' + country);
    res.status(500).send('We only work in the US. <br> You have not been charged.');
    return;
  }

  var charge = stripe.charges.create({
    amount: 99,
    currency: 'usd',
    description: '',
    source: req.body.stripe,
    receipt_email: req.body.email,
  }, function(err, charge) {
    if (err) {
      console.log(err);
      res.status(500).send('We had trouble with your payment. <br> Please try again.');
    } else {
      res.send('Subscribed! You won\'t get a text until the score gets close.');
    }
  });

  const ref = admin.database().ref('/subscriptions');
  ref.child(number).once('value', function (snapshot) {
    snapshot.ref.set({score: score, email: req.body.email});
  });
});
