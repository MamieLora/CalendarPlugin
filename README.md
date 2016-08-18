# CalendarPlugin
KeeeX plugin that extracts, display events in a calendar and gives you the ability to synchronize your events on Google Calendar.

<< image >>

## Install
You can directly download it through KeeeX Plugins Manager : KeeeX Calendar

## Development setup
You'll need :
* nodejs 4.X
* npm 3.x
* nw.js 0.12.x
* Grunt


```bash
git clone https://github.com/KeeeX/CalendarPlugin.git
cd CalendarPlugin
npm install # For the environment dépendencies
cd src
npm install # For the calendar dépendencies
```

Now you workspace should be ready.
For your tests, you can just give the src dir as argument to nw.js.

If you wan to use Google Calendar sync, you'll need to register your app on the ![Google API Dashboard](https://console.developers.google.com/apis) and put the OAuth credentials on a file called `googleApisClientSecret.json` in the `src` folder. 

## Contribute
It's simple as 1,2,3

1. Fork the repo
2. Do your changes and test them
3. Open a pull request :)