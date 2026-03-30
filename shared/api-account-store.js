/**
 * Quido API Account Store — v1.0
 *
 * Drop-in replacement / wrapper for Quido.createAccountStore() that
 * writes every mutation to the Quido backend API in addition to the
 * local localStorage store.
 *
 * Architecture (Priority 1 — write-through migration):
 *
 *   ┌───────────────────────────────────────────────────────┐
 *   │  HTML app calls _store.dispatch(cmd)                  │
 *   │              ↓                                        │
 *   │  api-account-store.dispatch()                         │
 *   │   ├─ 1. localStore.dispatch(cmd)   ← sync, UI fast  │
 *   │   └─ 2. POST /api/accounts/:key/commands  ← async   │
 *   │              ↓                                        │
 *   │  On login / reload:                                   │
 *   │   ├─ 1. localStore.loadLegacy()    ← sync, immediate │
 *   │   └─ 2. POST /api/accounts/sync   ← async reconcile  │
 *   │         if backend newer → update localStorage        │
 *   └───────────────────────────────────────────────────────┘
 *
 * Usage:
 *   var USE_API  = true;
 *   var localStore = Quido.createAccountStore({ ... });
 *   var _store = USE_API
 *     ? Quido.createApiAccountStore({ localStore: localStore, storageKey: ACCT_KEY })
 *     : localStore;
 *
 * The returned store exposes the same interface as createAccountStore:
 *   .loadLegacy(key, seed) → state (synchronous; async sync fires in background)
 *   .load(key, seed)       → alias for loadLegacy
 *   .getState()            → current cached state
 *   .getActiveLoan()       → active loan object
 *   .dispatch(command)     → apply mutation (sync local, async API)
 *   .subscribe(fn)         → register state-change listener
 *   .reload()              → re-fetch from API, update localStorage, notify
 *
 * Depends on: nothing (vanilla JS, no ES modules)
 * Loads after: quido-core.js
 */
;(function (global) {
  'use strict';

  var Quido = global.Quido || (global.Quido = {});

  // Default API base URL — override per environment
  var DEFAULT_API_BASE = 'http://localhost:3001/api';

  // ── Low-level fetch helpers ─────────────────────────────────────────────

  function apiGet(base, path) {
    return window.fetch(base + path, {
      method:  'GET',
      headers: { 'Accept': 'application/json' }
    }).then(function (r) {
      if (!r.ok) throw new Error('GET ' + path + ' → ' + r.status);
      return r.json();
    });
  }

  function apiPost(base, path, body) {
    return window.fetch(base + path, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body:    JSON.stringify(body)
    }).then(function (r) {
      if (!r.ok) throw new Error('POST ' + path + ' → ' + r.status);
      return r.json();
    });
  }

  // ── createApiAccountStore ───────────────────────────────────────────────

  /**
   * @param {Object} options
   * @param {Object} options.localStore    — existing Quido.createAccountStore() instance
   * @param {string} options.storageKey    — customer's storageKey
   * @param {string} [options.apiBase]     — API root (default: http://localhost:3001/api)
   * @param {boolean} [options.silent]     — suppress console warnings when API is unavailable
   */
  function createApiAccountStore(options) {
    var localStore        = options.localStore;
    var storageKey        = options.storageKey || '';
    var apiBase           = (options.apiBase || DEFAULT_API_BASE).replace(/\/$/, '');
    var silent            = !!options.silent;
    var apiOnline         = true; // optimistically assume online; flipped on first failure
    var _resolvedState    = null; // cached resolved account from GET /resolved
    var _resolvedListeners = [];  // callbacks registered via subscribeResolved()

    function warn(msg) {
      if (!silent) console.warn('[Quido API store]', msg);
    }

    function emitResolved() {
      for (var i = 0; i < _resolvedListeners.length; i++) {
        try { _resolvedListeners[i](_resolvedState); } catch (e) {}
      }
    }

    // ── Background sync helpers ───────────────────────────────────────────

    /**
     * Fetch the pre-computed resolved account from the backend and cache it.
     * Notifies all subscribeResolved() listeners when the state arrives.
     * Called automatically after sync and after every command.
     */
    function fetchResolved(key) {
      var k = key || storageKey;
      if (!k) return;
      apiGet(apiBase, '/accounts/' + k + '/resolved')
        .then(function (data) {
          apiOnline = true;
          var resolved = data && data.resolved;
          if (resolved) {
            _resolvedState = resolved;
            emitResolved();
          }
        })
        .catch(function () {
          // Backend offline — resolved state stays as last cached value
        });
    }

    /**
     * Push client state to the backend.
     * If backend has a newer version, update localStorage and refresh inner store.
     */
    function syncWithBackend(key, seed) {
      var clientState = localStore ? localStore.getState() : null;
      apiPost(apiBase, '/accounts/sync', {
        storageKey: key,
        account:    clientState,
        seed:       seed || null
      }).then(function (result) {
        apiOnline = true;
        var backendAccount = result.account;
        var source         = result.source;

        // Backend returned a newer account — normalize (runs migrations) then patch localStorage
        if (source === 'backend' && backendAccount) {
          var localVer   = clientState ? (clientState.version || 0) : 0;
          var backendVer = backendAccount.version || 0;
          if (backendVer > localVer) {
            // Run migrations so client-only fields (e.g. granular I&E) are always present
            var toStore = (Quido && Quido.normalizeAccount)
              ? Quido.normalizeAccount(backendAccount, seed)
              : backendAccount;
            try {
              window.localStorage.setItem(key, JSON.stringify(toStore));
            } catch (e) {}
            if (localStore) localStore.reload();
          }
        }

        // After sync completes, fetch the resolved view so both apps get
        // the pre-computed projection immediately on login
        fetchResolved(key);
      }).catch(function (err) {
        if (apiOnline) {
          apiOnline = false;
          warn('Backend unavailable — running offline on localStorage. (' + err.message + ')');
        }
      });
    }

    /**
     * Fire-and-forget: POST command to backend.
     * If the backend responds with an updated account that is newer, reconcile.
     */
    function postCommandToApi(command) {
      if (!storageKey) return;
      apiPost(apiBase, '/accounts/' + storageKey + '/commands', command)
        .then(function (result) {
          apiOnline = true;
          // Backend may have applied additional logic — if its version is higher, reconcile
          var backendAccount = result && result.account;
          var localState     = localStore ? localStore.getState() : null;
          if (backendAccount && localState) {
            var localVer   = localState.version || 0;
            var backendVer = backendAccount.version || 0;
            if (backendVer > localVer + 1) {
              try {
                window.localStorage.setItem(storageKey, JSON.stringify(backendAccount));
              } catch (e) {}
              if (localStore) localStore.reload();
            }
          }
          // Refresh resolved view after every successful command
          fetchResolved(storageKey);
        })
        .catch(function (err) {
          if (apiOnline) {
            apiOnline = false;
            warn('Command not persisted to backend — mutation is local only. (' + err.message + ')');
          }
        });
    }

    // ── Store interface ───────────────────────────────────────────────────

    var store = {

      /**
       * Load account for storageKey.
       * Synchronous path: delegates to localStore (fast, unchanged UX).
       * Async path: background sync with backend to reconcile versions.
       */
      loadLegacy: function (key, seed) {
        storageKey = key || storageKey;
        var state = localStore ? localStore.loadLegacy(key, seed) : null;
        // Background: push/pull from backend
        syncWithBackend(key, seed);
        return state;
      },

      /** Alias — same signature as createAccountStore */
      load: function (key, seed) {
        return this.loadLegacy(key, seed);
      },

      /** Return current state (from localStorage cache) */
      getState: function () {
        return localStore ? localStore.getState() : null;
      },

      /** Return active loan from current state */
      getActiveLoan: function () {
        return localStore ? localStore.getActiveLoan() : null;
      },

      /**
       * Apply a command mutation.
       * 1. Applies synchronously via localStore (UI stays responsive).
       * 2. Fires async POST to backend (persists to canonical source of truth).
       */
      dispatch: function (command) {
        // Local-first for responsiveness
        if (localStore) localStore.dispatch(command);
        // Async persistence to backend
        postCommandToApi(command);
      },

      /**
       * Register a listener for state changes.
       * Delegates to localStore so all existing subscription patterns work.
       */
      subscribe: function (fn) {
        return localStore ? localStore.subscribe(fn) : function () {};
      },

      /**
       * Re-fetch from backend.
       * If backend has a newer account, patches localStorage and triggers
       * localStore.reload() so all subscribers / bridge variables update.
       *
       * Returns a Promise that resolves with the freshest account.
       */
      reload: function () {
        if (!storageKey) {
          return localStore ? localStore.reload() : Promise.resolve(null);
        }
        return apiGet(apiBase, '/accounts/' + storageKey)
          .then(function (data) {
            apiOnline = true;
            var backendAccount = data && data.account;
            if (!backendAccount) return localStore ? localStore.getState() : null;

            var localState = localStore ? localStore.getState() : null;
            var localVer   = localState ? (localState.version || 0) : 0;
            var backendVer = backendAccount.version || 0;

            if (backendVer > localVer) {
              var toStoreR = (Quido && Quido.normalizeAccount)
                ? Quido.normalizeAccount(backendAccount, null)
                : backendAccount;
              try {
                window.localStorage.setItem(storageKey, JSON.stringify(toStoreR));
              } catch (e) {}
            }
            // Always reload inner store from localStorage after update
            return localStore ? localStore.reload() : backendAccount;
          })
          .catch(function (err) {
            warn('reload from backend failed — using local state. (' + err.message + ')');
            return localStore ? localStore.reload() : null;
          });
      },

      /**
       * Return the cached resolved account view (synchronous).
       * Returns null until the first fetchResolved() completes.
       * Both frontends check this in their bridge functions (applyLoanOverrides /
       * loadState) and use it in preference to raw v3 store assembly.
       */
      getResolvedState: function () { return _resolvedState; },

      /**
       * Register a listener that fires whenever new resolved state arrives.
       * Use this to trigger a UI refresh after the backend projection lands.
       * @param {Function} fn  — called with (resolvedState)
       * @returns {Function}   — unsubscribe function
       */
      subscribeResolved: function (fn) {
        _resolvedListeners.push(fn);
        return function () {
          var idx = _resolvedListeners.indexOf(fn);
          if (idx > -1) _resolvedListeners.splice(idx, 1);
        };
      },

      /**
       * Manually trigger a fetch of the resolved view (e.g. after a cross-tab
       * sync event refreshes the account).
       */
      refreshResolved: function () { fetchResolved(storageKey); },

      /** True if the backend was reachable on the last attempt */
      isOnline: function () { return apiOnline; },

      /** Expose the underlying local store for debugging */
      _localStore: localStore
    };

    return store;
  }

  // ── Expose on Quido namespace ─────────────────────────────────────────
  Quido.createApiAccountStore = createApiAccountStore;
  Quido.API_BASE = DEFAULT_API_BASE;

})(typeof window !== 'undefined' ? window : this);
