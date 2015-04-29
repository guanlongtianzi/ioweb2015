/**
 * Copyright 2015 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

self.IOWA = self.IOWA || {};

IOWA.Schedule = (function() {

  "use strict";

  var SCHEDULE_ENDPOINT = 'api/v1/schedule';
  var SCHEDULE_ENDPOINT_USERS = 'api/v1/user/schedule';
  var QUEUED_SESSION_UPDATES_DB_NAME = 'shed-offline-session-updates';

  var scheduleData_ = null;
  var userSavedSessions_ = [];

  // A promise fulfilled by the loaded schedule.
  var scheduleDeferredPromise = null;

  // The resolve function for scheduleDeferredPromise;
  var scheduleDeferredPromiseResolver = null;

  /**
   * Create the deferred schedule-fetching promise `scheduleDeferredPromise`.
   * @private
   */
  function createScheduleDeferred_() {
    var scheduleDeferred = IOWA.Util.createDeferred();
    scheduleDeferredPromiseResolver = scheduleDeferred.resolve;
    scheduleDeferredPromise = scheduleDeferred.promise.then(function(data) {
      scheduleData_ = data.scheduleData;
      IOWA.Elements.Template.scheduleData = data.scheduleData;
      IOWA.Elements.Template.filterSessionTypes = data.tags.filterSessionTypes;
      IOWA.Elements.Template.filterThemes = data.tags.filterThemes;
      IOWA.Elements.Template.filterTopics = data.tags.filterTopics;

      return scheduleData_;
    });
  }

  /**
   * Fetches the I/O schedule data. If the schedule has not been loaded yet, a
   * network request is kicked off. To wait on the schedule without causing a
   * triggering a request for it, use `schedulePromise`.
   * @return {Promise} Resolves with response schedule data.
   */
  function fetchSchedule() {
    if (scheduleData_) {
      return Promise.resolve(scheduleData_);
    }

    return IOWA.Request.xhrPromise('GET', SCHEDULE_ENDPOINT, false).then(function(resp) {
      scheduleData_ = resp;
      return scheduleData_;
    });
  }

  /**
   * Returns a promise fulfilled when the master schedule is loaded.
   * @return {!Promise} Resolves with response schedule data.
   */
  function schedulePromise() {
    if (!scheduleDeferredPromise) {
      createScheduleDeferred_();
    }

    return scheduleDeferredPromise;
  }

  /**
   * Resolves the schedule-fetching promise.
   * @param {{scheduleData, tags}} data
   */
  function resolveSchedulePromise(data) {
    if (!scheduleDeferredPromiseResolver) {
      createScheduleDeferred_();
    }

    scheduleDeferredPromiseResolver(data);
  }

  /**
   * Fetches the user's saved sessions.
   * If this is the first time it's been called, then uses the cache-then-network strategy to
   * first try to read the data stored in the Cache Storage API, and invokes the callback with that
   * response. It then tries to fetch a fresh copy of the data from the network, saves the response
   * locally in memory, and resolves the promise with that response.
   * @param {function} callback The callback to execute when the user schedule data is available.
   */
  function fetchUserSchedule(callback) {
    if (userSavedSessions_.length) {
      callback(userSavedSessions_);
    } else {
      var callbackWrapper = function(userSavedSessions) {
        userSavedSessions_ = userSavedSessions || [];
        callback(userSavedSessions_);
      };

      IOWA.Request.cacheThenNetwork(SCHEDULE_ENDPOINT_USERS, callback, callbackWrapper, true);
    }
  }

  /**
   * Wait for the master schedule to have loaded, then use `fetchUserSchedule`
   * to fetch the user's schedule and finally bind it for display.
   */
  function loadUserSchedule() {
    // Only fetch their schedule if the worker has responded with the master
    // schedule and the user is signed in.
    schedulePromise().then(IOWA.Auth.waitForSignedIn).then(function() {
      IOWA.Elements.Template.scheduleFetchingUserData = true;

      // Fetch user's saved sessions.
      fetchUserSchedule(function(savedSessions) {
        var template = IOWA.Elements.Template;
        template.scheduleFetchingUserData = false;
        template.savedSessions = savedSessions;
        updateSavedSessionsUI(template.savedSessions);
      });
    });
  }

  /**
   * Adds/removes a session from the user's bookmarked sessions.
   * @param {string} sessionId The session to add/remove.
   * @param {Boolean} save True if the session should be added, false if it
   *     should be removed.
   * @return {Promise} Resolves with the server's response.
   */
  function saveSession(sessionId, save) {
    IOWA.Analytics.trackEvent('session', 'bookmark', save);

    return IOWA.Auth.waitForSignedIn('Sign in to add events to My Schedule').then(function() {
      IOWA.Elements.Template.scheduleFetchingUserData = true;
      var url = SCHEDULE_ENDPOINT_USERS + '/' + sessionId;
      return IOWA.Request.xhrPromise(save ? 'PUT' : 'DELETE', url, true)
        .then(clearCachedUserSchedule)
        .catch(function(error) {
          IOWA.Elements.Template.scheduleFetchingUserData = false;
          // error will be an XMLHttpRequestProgressEvent if the xhrPromise() was rejected due to
          // a network error. Otherwise, error will be a Error object.
          if ('serviceWorker' in navigator && XMLHttpRequestProgressEvent &&
              error instanceof XMLHttpRequestProgressEvent) {
            IOWA.Elements.Toast.showMessage('Unable to modify My Schedule. The change will be retried on your next visit.');
          } else {
            IOWA.Elements.Toast.showMessage('Unable to modify My Schedule.');
          }
          throw error;
        });
    });
  }

  function generateFilters(tags) {
    var filterSessionTypes = [];
    var filterThemes = [];
    var filterTopics = [];

    var sortedTags = Object.keys(tags).map(function(tag) {
      return tags[tag];
    }).sort(function(a, b) {
      if (a.order_in_category < b.order_in_category) {
        return -1;
      }
      if (a.order_in_category > b.order_in_category) {
        return 1;
      }
      return 0;
    });

    for (var i = 0; i < sortedTags.length; ++i) {
      var tag = sortedTags[i];
      switch (tag.category) {
        case 'TYPE':
          filterSessionTypes.push(tag.name);
          break;
        case 'TOPIC':
          filterTopics.push(tag.name);
          break;
        case 'THEME':
          filterThemes.push(tag.name);
          break;
      }
    }

    return {
      filterSessionTypes: filterSessionTypes,
      filterThemes: filterThemes,
      filterTopics: filterTopics
    };
  }

  function updateSavedSessionsUI(savedSessions) {
    //  Mark/unmarked sessions the user has bookmarked.
    if (savedSessions.length) {
      var sessions = IOWA.Elements.Template.scheduleData.sessions;
      for (var i = 0; i < sessions.length; ++i) {
        var session = sessions[i];
        session.saved = savedSessions.indexOf(session.id) !== -1;
      }
    }
  }

  function clearCachedUserSchedule() {
    userSavedSessions_ = [];
  }

  /**
   * Clear all user schedule data from display.
   */
  function clearUserSchedule() {
    var template = IOWA.Elements.Template;
    template.savedSessions = [];
    updateSavedSessionsUI(template.savedSessions);
    clearCachedUserSchedule();
  }

  function getSessionById(sessionId) {
    for (var i = 0; i < scheduleData_.sessions.length; ++i) {
      var session = scheduleData_.sessions[i];
      if (session.id === sessionId) {
        return session;
      }
    }
    return null;
  }

  /**
   * Checks to see if there are any failed schedule update requests queued in IndexedDB, and if so,
   * replays them. Should only be called when auth is available, i.e. after login.
   *
   * @return {Promise} Resolves once the replay attempts are done, whether or not they succeeded.
   */
  function replayQueuedRequests() {
    // Only bother checking for queued requests if we're on a browser with service worker support,
    // since they can't be queued otherwise. This has a side effect of working around a bug in
    // Safari triggered by the simpleDB library.
    if ('serviceWorker' in navigator) {
      return simpleDB.open(QUEUED_SESSION_UPDATES_DB_NAME).then(function(db) {
        var replayPromises = [];
        // forEach is a special method implemented by SimpleDB, and isn't the normal Array.forEach.
        return db.forEach(function(url, method) {
          var replayPromise = IOWA.Request.xhrPromise(method, url, true).then(function() {
            return db.delete(url).then(function() {
              return true;
            });
          });
          replayPromises.push(replayPromise);
        }).then(function() {
          if (replayPromises.length) {
            return Promise.all(replayPromises).then(function() {
              IOWA.Elements.Toast.showMessage('My Schedule was updated with offline changes.');
            });
          }
        });
      }).catch(function() {
        IOWA.Elements.Toast.showMessage('Offline changes could not be applied to My Schedule.');
      });
    } else {
      return Promise.resolve();
    }
  }

  /**
   * Deletes the IndexedDB database used to queue up failed requests.
   * Useful when, e.g., the user has logged out.
   *
   * @return {Promise} Resolves once the IndexedDB database is deleted.
   */
  function clearQueuedRequests() {
    return simpleDB.delete(QUEUED_SESSION_UPDATES_DB_NAME);
  }

  return {
    clearCachedUserSchedule: clearCachedUserSchedule,
    fetchSchedule: fetchSchedule,
    schedulePromise: schedulePromise,
    resolveSchedulePromise: resolveSchedulePromise,
    fetchUserSchedule: fetchUserSchedule,
    loadUserSchedule: loadUserSchedule,
    saveSession: saveSession,
    generateFilters: generateFilters,
    getSessionById: getSessionById,
    updateSavedSessionsUI: updateSavedSessionsUI,
    replayQueuedRequests: replayQueuedRequests,
    clearQueuedRequests: clearQueuedRequests,
    clearUserSchedule: clearUserSchedule
  };

})();
