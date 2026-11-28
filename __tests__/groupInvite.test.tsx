// components/GroupInvite.tsx: the group's invite panel. docs/specs/2026-11-26-groups-mvp.md T13
// (GroupInvite), GR-28 (no group name in the message), GR-23 (any member makes a new link).
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { AccessibilityInfo, Modal, Platform, Share } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { GroupInvite } from '@/components/GroupInvite';
import { sendSms } from '@/lib/contactPicker';
import { supabase as realSupabase } from '@/lib/supabase';
import type { FakeResult, FakeSupabase } from '@/test-utils/fakes';

jest.mock('@/lib/supabase', () => {
  const { createFakeSupabase } = jest.requireActual<typeof import('@/test-utils/fakes')>('@/test-utils/fakes');
  return { supabase: createFakeSupabase() };
});
// "From contacts" is on (iOS/Android); the picker and Messages are stand-ins.
jest.mock('@/lib/contactPicker', () => ({
  contactsSupported: true,
  pickContactPhones: jest.fn(async () => ({ status: 'picked', phones: [{ number: '+15551234567', label: 'mobile' }] })),
  smsAvailable: jest.fn(async () => true),
  sendSms: jest.fn(async () => 'done'),
}));
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
// The link per platform, as Linking.createURL builds it in dev (lib/groupInviteLink.test.ts covers the real builder).
jest.mock('@/lib/groupInviteLink', () => ({
  groupInviteUrl: (code: string) =>
    jest.requireActual<typeof import('react-native')>('react-native').Platform.OS === 'web'
      ? `http://localhost:8081/g/${code}`
      : `splitit://g/${code}`,
}));

const supabase = realSupabase as unknown as FakeSupabase;
const GROUP = '9a000000-0000-4000-8000-000000000001';
const CODE = '0123456789abcdef0123';
const NEW_CODE = 'fedcba9876543210fedc';
const SERVER_TEXT = 'secret_internal_name for ada@example.com';

const rotations = () => supabase.rpc.mock.calls.filter(([fn]) => fn === 'rotate_group_code');
let rotate: () => FakeResult | Promise<FakeResult>;

beforeEach(() => {
  jest.clearAllMocks();
  rotate = () => ({ data: NEW_CODE, error: null });
  supabase.__setRpc((fn) => (fn === 'rotate_group_code' ? rotate() : { data: null, error: null }));
});

function renderPanel(onRotated = jest.fn()) {
  const view = render(<GroupInvite groupId={GROUP} joinCode={CODE} onRotated={onRotated} />);
  return { ...view, onRotated };
}

describe('GroupInvite on iOS', () => {
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'ios'));

  it('shows the link with what it does, Copy link, Share… and Show QR code', () => {
    renderPanel();
    expect(screen.getByText('Invite people')).toBeTruthy();
    expect(screen.getByText('Anyone with this link can join the group and see its costs.')).toBeTruthy();
    expect(screen.getByLabelText(`Invite link splitit://g/${CODE}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Share…' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Show QR code' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Make a new link' })).toBeTruthy();
  });

  it('Copy link copies the link and says so; a failed copy says what to do', async () => {
    renderPanel();
    fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Link copied')).toBeTruthy();
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`splitit://g/${CODE}`);
    jest.mocked(Clipboard.setStringAsync).mockResolvedValueOnce(false);
    fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText("Couldn't copy. Select the link and copy it yourself.")).toBeTruthy();
  });

  it('Share… sends "Join our group on SplitIt: <link>" (no group name, GR-28) and ignores taps while the sheet is open', async () => {
    let close: () => void = () => {};
    const share = jest.spyOn(Share, 'share').mockImplementation(
      () => new Promise((resolve) => (close = () => resolve({ action: Share.dismissedAction }))),
    );
    renderPanel();
    const button = screen.getByRole('button', { name: 'Share…' });
    fireEvent.press(button);
    fireEvent.press(button);
    expect(share).toHaveBeenCalledTimes(1);
    expect(share).toHaveBeenCalledWith({ message: `Join our group on SplitIt: splitit://g/${CODE}` });
    await act(async () => close());
    fireEvent.press(button);
    expect(share).toHaveBeenCalledTimes(2);
  });

  it('From contacts texts the group message, not the bill one (GR-T13-5)', async () => {
    renderPanel();
    fireEvent.press(screen.getByRole('button', { name: 'From contacts' }));
    const messages = await screen.findByRole('button', { name: 'Messages' });
    // R5: the hints say what the link is.
    expect(messages.props.accessibilityHint).toBe('Opens a text with the group link filled in');
    expect(screen.getByRole('button', { name: 'WhatsApp' }).props.accessibilityHint).toBe('Opens WhatsApp with the group link filled in');
    fireEvent.press(messages);
    await waitFor(() => expect(sendSms).toHaveBeenCalledWith('+15551234567', `Join our group on SplitIt: splitit://g/${CODE}`));
  });

  it('Show QR code opens a popup titled with the group name, with a QR of the same link; Done closes it', () => {
    render(<GroupInvite groupId={GROUP} joinCode={CODE} groupName="Tahoe trip" onRotated={jest.fn()} />);
    const show = screen.getByRole('button', { name: 'Show QR code' });
    expect(show.props.accessibilityHint).toBe('Opens a QR code friends can scan to open the invite link');
    expect(screen.queryByLabelText('QR code for the invite link')).toBeNull();
    fireEvent.press(show);
    expect(screen.getByRole('header', { name: 'Scan to join Tahoe trip' })).toBeTruthy();
    expect(screen.getByRole('image', { name: 'QR code for the invite link' })).toBeTruthy();
    expect(screen.UNSAFE_getByType(QRCode).props.value).toBe(`splitit://g/${CODE}`);
    expect(screen.queryByRole('button', { name: 'Hide QR code' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    expect(screen.queryByLabelText('QR code for the invite link')).toBeNull();
  });

  it('the popup has its own Copy link and "Link copied"; the share message still has no group name', async () => {
    render(<GroupInvite groupId={GROUP} joinCode={CODE} groupName="Tahoe trip" onRotated={jest.fn()} />);
    fireEvent.press(screen.getByRole('button', { name: 'Show QR code' }));
    // The panel's Copy link is behind the sheet; the sheet's is the last one.
    const copies = screen.getAllByRole('button', { name: 'Copy link' });
    await act(async () => fireEvent.press(copies[copies.length - 1]!));
    expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`splitit://g/${CODE}`);
    expect(screen.getByText('Link copied')).toBeTruthy();
  });

  it('without a group name the popup says "this group"', () => {
    renderPanel();
    fireEvent.press(screen.getByRole('button', { name: 'Show QR code' }));
    expect(screen.getByRole('header', { name: 'Scan to join this group' })).toBeTruthy();
  });

  it('VoiceOver goes back to "Show QR code" after the popup slides away', () => {
    const focus = jest.spyOn(AccessibilityInfo, 'sendAccessibilityEvent').mockImplementation(() => {});
    renderPanel();
    const show = screen.getByRole('button', { name: 'Show QR code' });
    fireEvent.press(show);
    fireEvent.press(screen.getByRole('button', { name: 'Done' }));
    act(() => screen.UNSAFE_getByType(Modal).props.onDismiss());
    const [target, event] = focus.mock.calls.at(-1) ?? [];
    expect(event).toBe('focus');
    // The trigger's own pressable (its hint is the "Show QR code" hint; the title has none).
    expect((target as unknown as { props: { accessibilityHint?: string } }).props.accessibilityHint).toBe(show.props.accessibilityHint);
    focus.mockRestore();
  });

  it('Make a new link asks first; Cancel changes nothing', () => {
    renderPanel();
    fireEvent.press(screen.getByRole('button', { name: 'Make a new link' }));
    expect(screen.getByText('The old link will stop working. People already in the group stay in.')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText(/The old link will stop working/)).toBeNull();
    expect(rotations()).toHaveLength(0);
  });

  it('confirming makes one new link: the panel shows it, tells the screen, and drops the old "Link copied"', async () => {
    const { onRotated } = renderPanel();
    fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    expect(await screen.findByText('Link copied')).toBeTruthy();
    fireEvent.press(screen.getByRole('button', { name: 'Make a new link' }));
    const confirm = screen.getByRole('button', { name: 'Make new link' });
    // Two taps before React re-renders: only the ref guard stops the second.
    act(() => {
      fireEvent.press(confirm);
      fireEvent.press(confirm);
    });
    expect(await screen.findByLabelText(`Invite link splitit://g/${NEW_CODE}`)).toBeTruthy();
    expect(rotations()).toEqual([['rotate_group_code', { p_group_id: GROUP }]]);
    expect(onRotated).toHaveBeenCalledWith(NEW_CODE);
    expect(screen.queryByText('Link copied')).toBeNull();
    expect(screen.queryByText(/The old link will stop working/)).toBeNull();
  });

  it('a failed new link: an alert, the old link stays, and the confirm works again', async () => {
    let fail = true;
    rotate = () => (fail ? { data: null, error: { code: '08006', message: SERVER_TEXT } } : { data: NEW_CODE, error: null });
    const { onRotated } = renderPanel();
    fireEvent.press(screen.getByRole('button', { name: 'Make a new link' }));
    fireEvent.press(screen.getByRole('button', { name: 'Make new link' }));
    expect(await screen.findByText("Couldn't make a new link. Try again.")).toBeTruthy();
    expect(screen.queryByText(new RegExp(SERVER_TEXT))).toBeNull();
    expect(screen.getByLabelText(`Invite link splitit://g/${CODE}`)).toBeTruthy();
    expect(onRotated).not.toHaveBeenCalled();
    fail = false;
    fireEvent.press(screen.getByRole('button', { name: 'Make new link' }));
    expect(await screen.findByLabelText(`Invite link splitit://g/${NEW_CODE}`)).toBeTruthy();
    expect(rotations()).toHaveLength(2);
  });

  it('a new code from the screen (after a refetch) replaces the link', () => {
    const { rerender } = renderPanel();
    rerender(<GroupInvite groupId={GROUP} joinCode={NEW_CODE} onRotated={jest.fn()} />);
    expect(screen.getByLabelText(`Invite link splitit://g/${NEW_CODE}`)).toBeTruthy();
  });
});

describe('GroupInvite on web', () => {
  const g = globalThis as { navigator?: unknown };
  const original = Object.getOwnPropertyDescriptor(g, 'navigator');
  beforeEach(() => jest.replaceProperty(Platform, 'OS', 'web'));
  afterEach(() => {
    if (original) Object.defineProperty(g, 'navigator', original);
    else Reflect.deleteProperty(g, 'navigator');
  });
  const setNavigator = (value: object) => Object.defineProperty(g, 'navigator', { configurable: true, value });

  it('without navigator.share: the localhost link and Copy link, no "Share…"', async () => {
    setNavigator({});
    renderPanel();
    expect(screen.getByLabelText(`Invite link http://localhost:8081/g/${CODE}`)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Copy link' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Share…' })).toBeNull();
    fireEvent.press(screen.getByRole('button', { name: 'Copy link' }));
    await waitFor(() => expect(Clipboard.setStringAsync).toHaveBeenCalledWith(`http://localhost:8081/g/${CODE}`));
  });

  it('with navigator.share: "Share…" shows', () => {
    setNavigator({ share: jest.fn() });
    renderPanel();
    expect(screen.getByRole('button', { name: 'Share…' })).toBeTruthy();
  });
});
