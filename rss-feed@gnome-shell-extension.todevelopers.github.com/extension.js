/*
 *  RSS Feed extension for GNOME Shell
 *  - Adds button with RSS logo in GNOME Shell panel.
 *  - Displays RSS soruces in popoup after click on panel button.
 *  - For each RSS source displays list of articles.
 *  - On click on RSS article opens default web browser with article link
 *
 * Copyright (C) 2015
 *     Tomas Gazovic <gazovic.tomasgmail.com>,
 *     Janka Gazovicova <jana.gazovicova@gmail.com>
 *
 * This file is part of gnome-shell-extension-rss-feed.
 *
 * gnome-shell-extension-rss-feed is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * gnome-shell-extension-rss-feed is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with gnome-shell-extension-rss-feed.  If not, see <http://www.gnu.org/licenses/>.
 */

const Gio = imports.gi.Gio;
const Lang = imports.lang;
const Main = imports.ui.main;
const Mainloop = imports.mainloop;
const Me = imports.misc.extensionUtils.getCurrentExtension();
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Soup = imports.gi.Soup;
const St = imports.gi.St;
const Util = imports.misc.util;

const Convenience = Me.imports.convenience;
const Parser = Me.imports.parser;

const RSS_FEEDS_LIST_KEY = 'rss-feeds-list';
const UPDATE_INTERVAL_KEY = 'update-interval';
const ITEMS_VISIBLE_KEY = 'items-visible';

/*
 *  PopupRssFeedMenuItem class that extends PopupMenuItem to provide RSS feed specific functionality
 *  After click on this popum menu item, default browser is opened with RSS item
 */
const PopupRssFeedMenuItem = new Lang.Class({

    Name: 'PopupRssFeedMenuItem',
    Extends: PopupMenu.PopupMenuItem,

    /*
     *  Initialize instance of PopupRssFeedMenuItem class
     *  link - URL on RSS article
     *  title - RSS title to display in widget
     */
    _init: function(link, title) {
        this.parent(title);

        this._link = link;

        try {
            // try to get default browser
            this._browser = Gio.app_info_get_default_for_uri_scheme("http").get_executable();
        }
        catch (err) {
            logError(err + ' (get default browser error)');
            throw 'get default browser error';
            return;
        }

        this.connect('activate', Lang.bind(this, function() {
            Util.trySpawnCommandLine(this._browser + ' ' + this._link);
        }));
    }
});

/*
 *  Main RSS Feed extension class
 */
const RssFeedButton = new Lang.Class({

    Name: 'RssFeedButton',
    Extends: PanelMenu.Button,

    /*
     *  Initialize instance of RssFeedButton class
     */
    _init: function() {
        this.parent(0.0, "RSS Feed");

        this._httpSession = null;
        this._settings = Convenience.getSettings();

        this._scid = this._settings.connect('changed', Lang.bind(this, this._onSettingsChanged));

        // top panel button
        let icon = new St.Icon({
            icon_name: 'application-rss+xml-symbolic',
            style_class: 'system-status-icon'
        });

        this.actor.add_actor(icon);

        this._feedsBox = new St.BoxLayout({
            vertical: true,
            reactive: false
        });

        this._feedsSection = new PopupMenu.PopupMenuSection();

        this.menu.addMenuItem(this._feedsSection);

        let separator = new PopupMenu.PopupSeparatorMenuItem();
        this.menu.addMenuItem(separator);

        // buttons in bottom menu bar
        this._buttonMenu = new PopupMenu.PopupBaseMenuItem({
            reactive: false
        });

        let systemMenu = Main.panel.statusArea.aggregateMenu._system;
        let prevBtn = systemMenu._createActionButton('go-previous-symbolic', "Previous");
        let nextBtn = systemMenu._createActionButton('go-next-symbolic', "Next");
        let reloadBtn = systemMenu._createActionButton('view-refresh-symbolic', "Reload RSS Feeds");
        let settingsBtn = systemMenu._createActionButton('preferences-system-symbolic', "RSS Feed Settings");

        this._lastUpdateTime = new St.Button({label: 'Last update: --:--'});

        this._buttonMenu.actor.add_actor(prevBtn);
        this._buttonMenu.actor.add_actor(nextBtn);
        this._buttonMenu.actor.add_actor(this._lastUpdateTime);
        this._buttonMenu.actor.add_actor(reloadBtn);
        this._buttonMenu.actor.add_actor(settingsBtn);

        prevBtn.connect('clicked', Lang.bind(this, this._onPreviousBtnClicked));
        nextBtn.connect('clicked', Lang.bind(this, this._onNextBtnClicked));
        reloadBtn.connect('clicked', Lang.bind(this, this._realoadRssFeeds));
        settingsBtn.connect('clicked', Lang.bind(this, this._onSettingsBtnClicked));

        this.menu.addMenuItem(this._buttonMenu);

        // load from settings
        // interval for updates
        this._updateInterval = this._settings.get_int(UPDATE_INTERVAL_KEY);
        // rss sources visible per page
        this._itemsVisible = this._settings.get_int(ITEMS_VISIBLE_KEY);
        // http sources for rss feeds
        this._rssFeedsSources = this._settings.get_strv(RSS_FEEDS_LIST_KEY);


        this._startIndex = 0;

        // array for GUI purposes
        this._feedsArray = new Array(this._rssFeedsSources.length);

        // loading data on startup
        this._realoadRssFeeds();
    },

    /*
     *  Frees resources of extension
     */
    stop: function() {

        if (this._httpSession)
            this._httpSession.abort();
        this._httpSession = null;

        if (this._scid)
            this._settings.disconnect(this._scid);

        if (this._timeout)
            Mainloop.source_remove(this._timeout);
    },

    /*
     *  On settings button clicked callback
     */
    _onSettingsBtnClicked: function() {

        this.menu.actor.hide();
        Util.spawn(["gnome-shell-extension-prefs", "rss-feed@gnome-shell-extension.todevelopers.github.com"]);
    },

    /*
     *  On previous button clicked callback
     */
    _onPreviousBtnClicked: function() {

        this._startIndex -= this._itemsVisible;
        if (this._startIndex < 0)
            this._startIndex = 0
        this._refreshExtensionUI();
    },

    /*
     *  On next button clicked callback
     */
    _onNextBtnClicked: function() {

        if (this._startIndex + this._itemsVisible < this._rssFeedsSources.length)
        {
            this._startIndex += this._itemsVisible;
            this._refreshExtensionUI();
        }
    },

    /*
     *  On settings changed callback
     */
    _onSettingsChanged: function() {

        this._updateInterval = this._settings.get_int(UPDATE_INTERVAL_KEY);
        this._itemsVisible = this._settings.get_int(ITEMS_VISIBLE_KEY);
        this._rssFeedsSources = this._settings.get_strv(RSS_FEEDS_LIST_KEY);

        this._feedsArray = new Array(this._rssFeedsSources.length);

        this._realoadRssFeeds();
    },

    /*
     *  Returns JSON object that represents HTTP (GET method) parameters
     *  stored in URL
     *  url - HTTP request URL
     */
    _getParametersAsJson: function(url) {

        if (url.indexOf('?') == -1)
            return "{}";

        let urlParams = url.substr(url.indexOf('?') + 1);
        let params = urlParams.split('&');

        let jsonObj = "{";
        for (let i = 0; i < params.length; i++)
        {
            let pair = params[i].split('=');
            jsonObj += '"' + pair[0] + '":' + '"' + pair[1] + '"';
            if (i != params.length -1)
                jsonObj += ',';
        }
        jsonObj += "}";

        return jsonObj;
    },

    /*
     *  Scheduled reload of RSS feeds from sources set in settings
     */
    _realoadRssFeeds: function() {

        if (this._timeout)
            Mainloop.source_remove(this._timeout);

        if (this._rssFeedsSources) {

            for (let i = 0; i < this._rssFeedsSources.length; i++)
            {
                let url = this._rssFeedsSources[i];
                let jsonObj = this._getParametersAsJson(url);

                if (url.indexOf('?') != -1)
                    url = url.substr(0, url.indexOf('?'));

                this._httpGetRequestAsync(url, JSON.parse(jsonObj), i, Lang.bind(this, this._onDownload));
            }
        }

        this._timeout = Mainloop.timeout_add_seconds(this._updateInterval*60, Lang.bind(this, this._realoadRssFeeds));
    },

    /*
     *  Creates asynchronous HTTP GET request through Soup interface
     *  url - HTTP request URL without parameters
     *  params - JSON object of HTTP GET request parameters
     *  position - Position in RSS sources list
     *  callback - calls on HTTP GET request response
     */
    _httpGetRequestAsync: function(url, params, position, callback) {

        if (this._httpSession == null)
            this._httpSession = new Soup.SessionAsync();

        let request = Soup.form_request_new_from_hash('GET', url, params);

        this._httpSession.queue_message(request, Lang.bind(this, function(httpSession, message) {
            log(JSON.stringify(message.response));
            if (message.response_body.data)
                callback(message.response_body.data, position);
        }));
    },

    /*
     *  Lead number with zeros
     *  num - input number
     *  size - size of number liadign with zeros
     */
    _pad: function (num, size) {
        let s = num + "";
        while (s.length < size) s = "0" + s;
        return s;
    },

    /*
     *  On HTTP request response download callback
     *  responseData - response data
     *  position - Position in RSS sources list
     */
    _onDownload: function(responseData, position) {

        let rssParser = new Parser.createRssParser(responseData);
        rssParser.parse();

        let rssFeed = {
            Publisher: {
                Title: ''
            },
            Items: []
        };
        rssFeed.Publisher.Title = rssParser.Publisher.Title;

        for (let i = 0; i < rssParser.Items.length; i++) {
            let item = {
                Title: '',
                HttpLink: ''
            };
            item.Title = rssParser.Items[i].Title;
            item.HttpLink = rssParser.Items[i].HttpLink;
            rssFeed.Items.push(item);
        }
        this._feedsArray[position] = rssFeed;

        this._refreshExtensionUI();

        // update last download time
        let time = new Date();
        this._lastUpdateTime.set_label('Last update: ' + this._pad(time.getHours(), 2)
            + ':' + this._pad(time.getMinutes(), 2));

        rssParser.clear();
    },

    /*
     *  Reloads feeds section
     */
    _refreshExtensionUI: function() {

        this._feedsSection.removeAll();

        let counter = 0;

        for (let i = this._startIndex; i < this._feedsArray.length; i++) {

            if (this._feedsArray[i] && this._feedsArray[i].Items) {

                let nItems = this._feedsArray[i].Items.length;

                let subMenu = new PopupMenu.PopupSubMenuMenuItem(this._feedsArray[i].Publisher.Title + ' (' + nItems + ')');

                for (let j = 0; j < nItems; j++) {

                    let menuItem = new PopupRssFeedMenuItem(this._feedsArray[i].Items[j].HttpLink, this._feedsArray[i].Items[j].Title);
                    subMenu.menu.addMenuItem(menuItem);
                }

                this._feedsSection.addMenuItem(subMenu);
            }
            else {

                let subMenu = new PopupMenu.PopupMenuItem('No data available');
                this._feedsSection.addMenuItem(subMenu);
            }

            counter++;

            if (counter == this._itemsVisible)
                break;

        }
    }
});

/*
 *  Extension widget instance
 */
let rssFeedBtn;

/*
 *  Initialize the extension
 */
function init() {

}

/*
 *  Enable the extension
 */
function enable() {
    rssFeedBtn = new RssFeedButton();
    Main.panel.addToStatusArea('rssFeedMenu', rssFeedBtn, 0, 'right');
}

/*
 *  Disable the exten
 */
function disable() {
    rssFeedBtn.stop();
    rssFeedBtn.destroy();
}
