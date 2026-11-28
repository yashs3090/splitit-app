// The check-in notification module on iOS/Android (docs/specs/2026-11-26-sent-via-venmo.md § D3, Task 8).
// The factory gets a fake expo-notifications, storage and platform, so no test needs a device.
// The last block checks the default instance's wiring onto the real package's names (mocked here).
import { act, renderHook } from '@testing-library/react-native';

import { createMemoryStorage } from '@/test-utils/fakes';

import { createCheckInNotifications, type NativeNotifications } from './checkInNotifications.native';
import type { SentCheckResponse } from './checkInNotifications.types';
import {
  NOTIF_ASKED_KEY,
  SENT_CHECK_ACTIONS,
  SENT_CHECK_CATEGORY_ID,
  SENT_CHECK_DELAY_SECONDS,
  SENT_CHECK_PREVIEW_PLACEHOLDER,
  sentCheckNotification,
  type SentCheckNotification,
} from './sentCheck';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const BILL = '33333333-3333-4333-8333-333333333333';
const PAYER = '44444444-4444-4444-8444-444444444444';
const MARK_AT = Date.parse('2026-11-26T18:00:00.000Z');
const DEFAULT_ACTION = 'expo.modules.notifications.actions.DEFAULT';

function notification(userId = USER, markAtMs = MARK_AT): SentCheckNotification {
  const n = sentCheckNotification({ payerName: 'Hana', billId: BILL, userId, payerId: PAYER, cents: 1510, markAtMs });
  if (n === null) throw new Error('fixture: sentCheckNotification returned null');
  return n;
}

type Listener = (r: unknown) => void;

function fakeNotifications() {
  const listeners = new Set<Listener>();
  let last: unknown = null;
  const n = {
    getPermissionsAsync: jest.fn(async (): Promise<unknown> => ({ status: 'undetermined', granted: false, ios: { status: 0 } })),
    requestPermissionsAsync: jest.fn(async (_req: unknown): Promise<unknown> => ({ status: 'granted', granted: true, ios: { status: 2 } })),
    setNotificationCategoryAsync: jest.fn(async (_id: string, _actions: unknown, _opts: unknown): Promise<unknown> => ({})),
    setNotificationChannelAsync: jest.fn(async (_id: string, _channel: unknown): Promise<unknown> => ({})),
    scheduleNotificationAsync: jest.fn(async (req: { identifier: string }): Promise<string> => req.identifier),
    cancelScheduledNotificationAsync: jest.fn(async (_id: string): Promise<void> => {}),
    dismissNotificationAsync: jest.fn(async (_id: string): Promise<void> => {}),
    getAllScheduledNotificationsAsync: jest.fn(async (): Promise<unknown[]> => []),
    getPresentedNotificationsAsync: jest.fn(async (): Promise<unknown[]> => []),
    addNotificationResponseReceivedListener: jest.fn((l: Listener) => {
      listeners.add(l);
      return { remove: jest.fn(() => listeners.delete(l)) };
    }),
    getLastNotificationResponse: jest.fn((): unknown => last),
    clearLastNotificationResponse: jest.fn(() => {
      last = null;
    }),
  };
  return {
    n,
    emit: (r: unknown) => listeners.forEach((l) => l(r)),
    setLast: (r: unknown) => {
      last = r;
    },
    listenerCount: () => listeners.size,
  };
}

function setup(platform: 'ios' | 'android' = 'ios') {
  const fake = fakeNotifications();
  const storage = createMemoryStorage();
  const api = createCheckInNotifications({
    notifications: fake.n as unknown as NativeNotifications, // the fake's jest.fn types are looser than the real ones
    storage,
    platform,
    defaultActionIdentifier: DEFAULT_ACTION,
  });
  return { ...fake, storage, api };
}

function response(identifier: string, actionIdentifier: string, data: unknown = notification().content.data) {
  return { actionIdentifier, notification: { request: { identifier, content: { data } } } };
}

/** A promise that never settles: the "never arrives" path. */
const never = <T>() => new Promise<T>(() => {});

afterEach(() => {
  jest.useRealTimers();
});

describe('permission', () => {
  it.each([
    [0, 'undetermined'],
    [1, 'denied'],
    [2, 'granted'],
    [3, 'granted'],
    [4, 'granted'],
  ] as const)('iOS reads ios.status %s as %s, whatever the root fields say', async (status, expected) => {
    const { n, api } = setup('ios');
    // Root fields deliberately disagree: provisional comes back as undetermined / granted: false.
    n.getPermissionsAsync.mockResolvedValue({ status: 'undetermined', granted: false, ios: { status } });
    await expect(api.notificationPermission()).resolves.toBe(expected);
  });

  it.each([
    ['granted', 'granted'],
    ['denied', 'denied'],
    ['undetermined', 'undetermined'],
  ] as const)('Android reads the root status %s as %s', async (status, expected) => {
    const { n, api } = setup('android');
    n.getPermissionsAsync.mockResolvedValue({ status, granted: status === 'granted', android: { importance: 4 } });
    await expect(api.notificationPermission()).resolves.toBe(expected);
  });

  it('a failed or hung permission read is treated as denied (silence, never asks)', async () => {
    const { n, api } = setup();
    n.getPermissionsAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(api.notificationPermission()).resolves.toBe('denied');

    jest.useFakeTimers();
    n.getPermissionsAsync.mockImplementationOnce(never);
    const p = api.notificationPermission();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await expect(p).resolves.toBe('denied');
  });

  it('asks once on iOS: full authorization (alert + sound, no badge, not provisional), flag set before asking', async () => {
    const { n, api, storage } = setup('ios');
    n.requestPermissionsAsync.mockImplementation(async () => {
      expect(storage.data.get(NOTIF_ASKED_KEY)).toBeDefined();
      return { status: 'granted', granted: true, ios: { status: 2 } };
    });
    await expect(api.askNotificationPermissionOnce()).resolves.toBe('granted');
    expect(n.requestPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(n.requestPermissionsAsync).toHaveBeenCalledWith({ ios: { allowAlert: true, allowSound: true } });
    expect(n.setNotificationChannelAsync).not.toHaveBeenCalled();

    // Second Pay: still undetermined in the OS's eyes (e.g. the prompt was dismissed), but never re-asked.
    await expect(api.askNotificationPermissionOnce()).resolves.toBe('undetermined');
    expect(n.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });

  it('does not ask when already decided (denied stays silent)', async () => {
    const { n, api } = setup('ios');
    n.getPermissionsAsync.mockResolvedValue({ status: 'denied', granted: false, ios: { status: 1 } });
    await expect(api.askNotificationPermissionOnce()).resolves.toBe('denied');
    expect(n.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('Android creates the sent_check channel before asking', async () => {
    const { n, api } = setup('android');
    const order: string[] = [];
    n.setNotificationChannelAsync.mockImplementation(async () => {
      order.push('channel');
      return {};
    });
    n.requestPermissionsAsync.mockImplementation(async () => {
      order.push('request');
      return { status: 'granted', granted: true };
    });
    await expect(api.askNotificationPermissionOnce()).resolves.toBe('granted');
    expect(order).toEqual(['channel', 'request']);
    expect(n.setNotificationChannelAsync).toHaveBeenCalledWith('sent_check', {
      name: 'Payment check-ins',
      importance: 'high',
      sound: null,
      showBadge: false,
    });
  });

  it('does not ask when the asked flag cannot be read or written (ask at most once)', async () => {
    const a = setup();
    a.storage.getItem = jest.fn(async () => {
      throw new Error('read');
    });
    await expect(a.api.askNotificationPermissionOnce()).resolves.toBe('undetermined');
    expect(a.n.requestPermissionsAsync).not.toHaveBeenCalled();

    const b = setup();
    b.storage.setItem = jest.fn(async () => {
      throw new Error('write');
    });
    await expect(b.api.askNotificationPermissionOnce()).resolves.toBe('undetermined');
    expect(b.n.requestPermissionsAsync).not.toHaveBeenCalled();
  });

  it('a prompt that never answers gives up after the limit as undetermined', async () => {
    jest.useFakeTimers();
    const { n, api } = setup();
    n.requestPermissionsAsync.mockImplementation(never);
    const p = api.askNotificationPermissionOnce();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60000);
    });
    await expect(p).resolves.toBe('undetermined');
  });

  it('a rejected prompt re-reads the permission', async () => {
    const { n, api } = setup();
    n.requestPermissionsAsync.mockRejectedValue(new Error('boom'));
    n.getPermissionsAsync
      .mockResolvedValueOnce({ status: 'undetermined', granted: false, ios: { status: 0 } })
      .mockResolvedValueOnce({ status: 'denied', granted: false, ios: { status: 1 } });
    await expect(api.askNotificationPermissionOnce()).resolves.toBe('denied');
  });

  it('two overlapping asks share one prompt', async () => {
    const { n, api } = setup();
    const [a, b] = await Promise.all([api.askNotificationPermissionOnce(), api.askNotificationPermissionOnce()]);
    expect([a, b]).toEqual(['granted', 'granted']);
    expect(n.requestPermissionsAsync).toHaveBeenCalledTimes(1);
  });
});

describe('category and channel', () => {
  it('registers sent_check with both actions, opensAppToForeground explicit, and the hidden-preview placeholder', async () => {
    const { n, api } = setup();
    await expect(api.ensureSentCheckCategory()).resolves.toBe(true);
    expect(n.setNotificationCategoryAsync).toHaveBeenCalledWith(
      SENT_CHECK_CATEGORY_ID,
      [
        { identifier: 'yes', buttonTitle: 'Yes', options: { opensAppToForeground: false } },
        { identifier: 'undo', buttonTitle: 'No, undo', options: { opensAppToForeground: true, isDestructive: true } },
      ],
      { previewPlaceholder: SENT_CHECK_PREVIEW_PLACEHOLDER },
    );
    const actions = n.setNotificationCategoryAsync.mock.calls[0]?.[1] as Array<{ options: Record<string, unknown> }>;
    for (const a of actions) expect(a.options).toHaveProperty('opensAppToForeground');
    expect(actions).toHaveLength(SENT_CHECK_ACTIONS.length);
  });

  it('is memoized, and retried after a failure', async () => {
    const { n, api } = setup();
    n.setNotificationCategoryAsync.mockRejectedValueOnce(new Error('boom'));
    await expect(api.ensureSentCheckCategory()).resolves.toBe(false);
    await expect(api.ensureSentCheckCategory()).resolves.toBe(true);
    await expect(api.ensureSentCheckCategory()).resolves.toBe(true);
    expect(n.setNotificationCategoryAsync).toHaveBeenCalledTimes(2);
  });

  it('a category call that never settles gives up (false) and is retried next time', async () => {
    jest.useFakeTimers();
    const { n, api } = setup();
    n.setNotificationCategoryAsync.mockImplementationOnce(never);
    const p = api.ensureSentCheckCategory();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await expect(p).resolves.toBe(false);
    await expect(api.ensureSentCheckCategory()).resolves.toBe(true);
  });

  it('the Android channel is created once; iOS has nothing to create', async () => {
    const android = setup('android');
    await expect(android.api.ensureAndroidChannel()).resolves.toBe(true);
    await expect(android.api.ensureAndroidChannel()).resolves.toBe(true);
    expect(android.n.setNotificationChannelAsync).toHaveBeenCalledTimes(1);

    const ios = setup('ios');
    await expect(ios.api.ensureAndroidChannel()).resolves.toBe(true);
    expect(ios.n.setNotificationChannelAsync).not.toHaveBeenCalled();
  });
});

describe('scheduleSentCheck', () => {
  it('iOS: registers the category, then schedules 60 s, no sound, no badge, the D3 content and identifier', async () => {
    const { n, api } = setup('ios');
    const order: string[] = [];
    n.setNotificationCategoryAsync.mockImplementation(async () => {
      order.push('category');
      return {};
    });
    n.scheduleNotificationAsync.mockImplementation(async (req) => {
      order.push('schedule');
      return req.identifier;
    });
    const sent = notification();
    await expect(api.scheduleSentCheck(sent)).resolves.toBe(true);
    expect(order).toEqual(['category', 'schedule']);
    const req = n.scheduleNotificationAsync.mock.calls[0]?.[0] as unknown as {
      identifier: string;
      content: Record<string, unknown>;
      trigger: Record<string, unknown>;
    };
    expect(req.identifier).toBe(`sentcheck.${USER}.${BILL}.${PAYER}.${MARK_AT}`);
    expect(req.content).toEqual({
      title: 'SplitIt',
      body: 'Did your $15.10 to Hana go through?',
      sound: false,
      categoryIdentifier: 'sent_check',
      data: { billId: BILL, userId: USER, payerId: PAYER, cents: 1510, markAtMs: MARK_AT },
    });
    expect(req.content).not.toHaveProperty('badge');
    expect(req.trigger).toEqual({ type: 'timeInterval', seconds: SENT_CHECK_DELAY_SECONDS, repeats: false });
    expect(SENT_CHECK_DELAY_SECONDS).toBe(60);
  });

  it('Android: creates the channel and puts it on the trigger', async () => {
    const { n, api } = setup('android');
    await expect(api.scheduleSentCheck(notification())).resolves.toBe(true);
    expect(n.setNotificationChannelAsync).toHaveBeenCalledTimes(1);
    const req = n.scheduleNotificationAsync.mock.calls[0]?.[0] as unknown as { trigger: Record<string, unknown> };
    expect(req.trigger).toEqual({ type: 'timeInterval', seconds: 60, repeats: false, channelId: 'sent_check' });
  });

  it('still schedules when the category could not be registered (the body tap still opens Settle)', async () => {
    const { n, api } = setup();
    n.setNotificationCategoryAsync.mockRejectedValue(new Error('boom'));
    await expect(api.scheduleSentCheck(notification())).resolves.toBe(true);
  });

  it('a rejected schedule is false', async () => {
    const { n, api } = setup();
    n.scheduleNotificationAsync.mockRejectedValue(new Error('boom'));
    await expect(api.scheduleSentCheck(notification())).resolves.toBe(false);
  });

  it('refuses an identifier that is not a check-in id, without calling the OS', async () => {
    const { n, api } = setup();
    const bad = { ...notification(), identifier: 'other:thing' };
    await expect(api.scheduleSentCheck(bad)).resolves.toBe(false);
    const wrongDelay = { ...notification(), trigger: { seconds: 0, repeats: false as const } };
    await expect(api.scheduleSentCheck(wrongDelay)).resolves.toBe(false);
    expect(n.scheduleNotificationAsync).not.toHaveBeenCalled();
  });

  it('gives up after SCHEDULE_TIMEOUT_MS, and cancels the schedule if it lands late', async () => {
    jest.useFakeTimers();
    const { n, api } = setup();
    let land: (id: string) => void = () => {};
    n.scheduleNotificationAsync.mockImplementation(() => new Promise<string>((r) => (land = r)));
    const sent = notification();
    const p = api.scheduleSentCheck(sent);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    await expect(p).resolves.toBe(false);
    expect(n.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    await act(async () => {
      land(sent.identifier);
    });
    expect(n.cancelScheduledNotificationAsync).toHaveBeenCalledWith(sent.identifier);
    expect(n.dismissNotificationAsync).toHaveBeenCalledWith(sent.identifier);
  });

  it('a slow category does not schedule after the limit has passed', async () => {
    jest.useFakeTimers();
    const { n, api } = setup();
    let done: () => void = () => {};
    n.setNotificationCategoryAsync.mockImplementation(() => new Promise((r) => (done = () => r({}))));
    const p = api.scheduleSentCheck(notification());
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    await expect(p).resolves.toBe(false);
    await act(async () => {
      done();
    });
    expect(n.scheduleNotificationAsync).not.toHaveBeenCalled();
  });
});

describe('cancel and dismiss', () => {
  const mine = notification(USER);
  const mineLater = notification(USER, MARK_AT + 5000);
  const theirs = notification(OTHER);
  const scheduled = (n: SentCheckNotification) => ({ identifier: n.identifier, content: { data: n.content.data } });
  const presented = (n: SentCheckNotification) => ({ request: scheduled(n) });
  const unrelated = { identifier: 'something-else', content: { data: { userId: USER } } };

  it('cancelSentCheck cancels the pending one and dismisses a presented one', async () => {
    const { n, api } = setup();
    await api.cancelSentCheck(mine.identifier);
    expect(n.cancelScheduledNotificationAsync).toHaveBeenCalledWith(mine.identifier);
    expect(n.dismissNotificationAsync).toHaveBeenCalledWith(mine.identifier);
  });

  it('cancelSentCheck ignores ids that are not check-ins, and never rejects', async () => {
    const { n, api } = setup();
    await api.cancelSentCheck('something-else');
    expect(n.cancelScheduledNotificationAsync).not.toHaveBeenCalled();
    n.cancelScheduledNotificationAsync.mockRejectedValue(new Error('boom'));
    n.dismissNotificationAsync.mockImplementation(() => {
      throw new Error('sync boom');
    });
    await expect(api.cancelSentCheck(mine.identifier)).resolves.toBeUndefined();
  });

  it("cancelSentChecks(user) clears only that user's check-ins, pending and presented", async () => {
    const { n, api } = setup();
    n.getAllScheduledNotificationsAsync.mockResolvedValue([scheduled(mine), scheduled(theirs), unrelated]);
    n.getPresentedNotificationsAsync.mockResolvedValue([presented(mineLater), presented(theirs), { request: unrelated }]);
    await api.cancelSentChecks(USER);
    expect(n.cancelScheduledNotificationAsync.mock.calls.map((c) => c[0])).toEqual([mine.identifier]);
    expect(n.dismissNotificationAsync.mock.calls.map((c) => c[0])).toEqual([mineLater.identifier]);
  });

  it('cancelAllSentChecks (sign-out) clears every check-in on the device and nothing else', async () => {
    const { n, api } = setup();
    n.getAllScheduledNotificationsAsync.mockResolvedValue([scheduled(mine), scheduled(theirs), unrelated]);
    n.getPresentedNotificationsAsync.mockResolvedValue([presented(mineLater), { request: unrelated }]);
    await api.cancelAllSentChecks();
    expect(n.cancelScheduledNotificationAsync.mock.calls.map((c) => c[0]).sort()).toEqual(
      [mine.identifier, theirs.identifier].sort(),
    );
    expect(n.dismissNotificationAsync.mock.calls.map((c) => c[0])).toEqual([mineLater.identifier]);
  });

  it('a hung list call still ends (the other list is still handled)', async () => {
    jest.useFakeTimers();
    const { n, api } = setup();
    n.getAllScheduledNotificationsAsync.mockImplementation(never);
    n.getPresentedNotificationsAsync.mockResolvedValue([presented(mine)]);
    const p = api.cancelSentChecks(USER);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(2000);
    });
    await expect(p).resolves.toBeUndefined();
    expect(n.dismissNotificationAsync).toHaveBeenCalledWith(mine.identifier);
  });

  it('cancelSentChecks with a blank user does nothing', async () => {
    const { n, api } = setup();
    await api.cancelSentChecks('');
    expect(n.getAllScheduledNotificationsAsync).not.toHaveBeenCalled();
  });
});

describe('responses', () => {
  const id = notification().identifier;

  it('maps the two actions and a body tap; ignores other notifications and actions', () => {
    const { api, emit } = setup();
    const got: SentCheckResponse[] = [];
    const off = api.subscribeSentCheckResponses((r) => got.push(r));
    emit(response(id, 'yes'));
    emit(response(id, 'undo'));
    emit(response(id, DEFAULT_ACTION));
    emit(response(id, 'expo.modules.notifications.actions.DISMISS'));
    emit(response('someone-elses-notification', 'yes'));
    emit({ nonsense: true });
    expect(got.map((r) => [r.action, r.source, r.key])).toEqual([
      ['yes', 'live', `${id}|yes`],
      ['undo', 'live', `${id}|undo`],
      ['open', 'live', `${id}|${DEFAULT_ACTION}`],
    ]);
    // Raw data is passed through untouched: the responder allow-lists it with parseSentCheckData.
    expect(got[0]?.data).toEqual(notification().content.data);
    off();
    emit(response(id, 'yes'));
    expect(got).toHaveLength(3);
  });

  it('a listener that cannot be added gives a harmless unsubscribe', () => {
    const { n, api } = setup();
    n.addNotificationResponseReceivedListener.mockImplementation(() => {
      throw new Error('boom');
    });
    const off = api.subscribeSentCheckResponses(() => {});
    expect(() => off()).not.toThrow();
  });

  it('last response: ours as cold, others ignored, errors are null; clear never throws', () => {
    const { n, api, setLast } = setup();
    expect(api.lastSentCheckResponse()).toBeNull();
    setLast(response(id, 'undo'));
    expect(api.lastSentCheckResponse()).toMatchObject({ action: 'undo', source: 'cold', identifier: id });
    setLast(response('not-ours', 'undo'));
    expect(api.lastSentCheckResponse()).toBeNull();
    n.getLastNotificationResponse.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(api.lastSentCheckResponse()).toBeNull();
    n.clearLastNotificationResponse.mockImplementation(() => {
      throw new Error('boom');
    });
    expect(() => api.clearLastSentCheckResponse()).not.toThrow();
  });

  it('the hook delivers the cold-start response, then live ones, each once, and clears the last response', () => {
    const { n, api, emit, setLast, listenerCount } = setup();
    setLast(response(id, 'undo'));
    const handler = jest.fn();
    const { unmount } = renderHook(() => api.useSentCheckResponses(handler));
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0]?.[0]).toMatchObject({ action: 'undo', source: 'cold' });
    expect(n.clearLastNotificationResponse).toHaveBeenCalled();

    emit(response(id, 'yes'));
    emit(response(id, 'yes')); // the same response twice is handled once
    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[1]?.[0]).toMatchObject({ action: 'yes', source: 'live' });

    unmount();
    expect(listenerCount()).toBe(0);
    emit(response(id, DEFAULT_ACTION));
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('a re-mount does not handle a response again, even if the OS still reports it as last', () => {
    const { api, setLast } = setup();
    const handler = jest.fn();
    setLast(response(id, 'undo'));
    renderHook(() => api.useSentCheckResponses(handler)).unmount();
    setLast(response(id, 'undo'));
    renderHook(() => api.useSentCheckResponses(handler));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('calls the latest handler, and a throwing handler does not break later responses', () => {
    const { api, emit } = setup();
    const first = jest.fn(() => {
      throw new Error('handler bug');
    });
    const second = jest.fn();
    const { rerender } = renderHook(({ h }: { h: (r: SentCheckResponse) => void }) => api.useSentCheckResponses(h), {
      initialProps: { h: first },
    });
    emit(response(id, 'yes'));
    expect(first).toHaveBeenCalledTimes(1);
    rerender({ h: second });
    emit(response(id, 'undo'));
    expect(second).toHaveBeenCalledTimes(1);
  });
});

describe('never asks for a push token', () => {
  it('the native file calls no push-token API', () => {
    const fs = jest.requireActual<{ readFileSync(file: string, encoding: 'utf8'): string }>('fs');
    const source = fs.readFileSync(`${process.cwd()}/lib/checkInNotifications.native.ts`, 'utf8');
    // Built from parts so the criterion-56 grep over lib/ does not match this test file.
    const pushApis = new RegExp(['getDevice', 'getExpo'].map((p) => `${p}PushTokenAsync`).concat('setAutoServerRegistrationEnabledAsync').join('|'));
    expect(pushApis.test(['getExpo', 'PushTokenAsync'].join(''))).toBe(true); // the pattern can match
    expect(source).not.toMatch(pushApis);
    // The check can find something: the file does import the package.
    expect(source).toMatch(/from ['"]expo-notifications['"]/);
  });
});

describe('default instance wiring (Platform.OS branches)', () => {
  function load(os: 'ios' | 'android') {
    const pkg = {
      SchedulableTriggerInputTypes: { TIME_INTERVAL: 'timeInterval' },
      AndroidImportance: { HIGH: 6 },
      DEFAULT_ACTION_IDENTIFIER: DEFAULT_ACTION,
      getPermissionsAsync: jest.fn(async () => ({ status: 'undetermined', granted: false, ios: { status: 0 } })),
      requestPermissionsAsync: jest.fn(async () => ({ status: 'granted', granted: true, ios: { status: 2 } })),
      setNotificationCategoryAsync: jest.fn(async () => ({})),
      setNotificationChannelAsync: jest.fn(async () => ({})),
      scheduleNotificationAsync: jest.fn(async (req: { identifier: string }) => req.identifier),
      cancelScheduledNotificationAsync: jest.fn(async () => {}),
      dismissNotificationAsync: jest.fn(async () => {}),
      getAllScheduledNotificationsAsync: jest.fn(async () => []),
      getPresentedNotificationsAsync: jest.fn(async () => []),
      addNotificationResponseReceivedListener: jest.fn(() => ({ remove: jest.fn() })),
      getLastNotificationResponse: jest.fn(() => null),
      clearLastNotificationResponse: jest.fn(),
    };
    let mod: typeof import('./checkInNotifications.native') | undefined;
    jest.resetModules();
    jest.isolateModules(() => {
      jest.doMock('expo-notifications', () => pkg);
      jest.doMock('./storage', () => ({ storage: createMemoryStorage() }));
      // The module reads only Platform.OS from react-native, once, when it loads.
      jest.doMock('react-native', () => ({ Platform: { OS: os } }));
      mod = require('./checkInNotifications.native') as typeof import('./checkInNotifications.native');
    });
    if (mod === undefined) throw new Error('module did not load');
    return { pkg, mod };
  }

  it('iOS: supported, maps the trigger type enum, no channel', async () => {
    const { pkg, mod } = load('ios');
    expect(mod.supported).toBe(true);
    expect(mod.checkInNotifications.supported).toBe(true);
    await expect(mod.scheduleSentCheck(notification())).resolves.toBe(true);
    expect(pkg.setNotificationChannelAsync).not.toHaveBeenCalled();
    expect(pkg.scheduleNotificationAsync.mock.calls[0]?.[0]).toMatchObject({
      trigger: { type: 'timeInterval', seconds: 60, repeats: false },
    });
  });

  it('Android: creates the channel with AndroidImportance.HIGH', async () => {
    const { pkg, mod } = load('android');
    await expect(mod.scheduleSentCheck(notification())).resolves.toBe(true);
    expect(pkg.setNotificationChannelAsync).toHaveBeenCalledWith('sent_check', {
      name: 'Payment check-ins',
      importance: 6,
      sound: null,
      showBadge: false,
    });
  });
});
