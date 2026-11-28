// useAssignItem's error copy (delete group spec A3): a clash between two writes (`busy`) reads as
// "That didn't go through. Please try again.", releases the control, and doesn't refetch.
import { act, renderHook } from '@testing-library/react-native';

import * as groups from './groups';
import { GROUP_ERROR_COPY } from './groups';
import { useAssignItem, type AssignSource } from './useAssignItem';

jest.mock('./supabase', () => ({ supabase: {} }));
jest.mock('./groups', () => {
  const actual = jest.requireActual<typeof import('./groups')>('./groups');
  return { ...actual, assignItem: jest.fn() };
});

const assignItem = groups.assignItem as jest.MockedFunction<typeof groups.assignItem>;
const ROW = '22222222-0000-4000-8000-000000000001';
const ME = '00000000-0000-4000-8000-00000000000a';

function source(refetch = jest.fn(() => 1)): AssignSource {
  return { lineItemId: ROW, current: {}, refetch, version: 0, finished: 0 };
}

beforeEach(() => jest.clearAllMocks());

describe('useAssignItem error copy', () => {
  it('busy shows the retry copy, releases the control and does not refetch', async () => {
    assignItem.mockResolvedValue({ ok: false, error: 'busy' });
    const refetch = jest.fn(() => 1);
    const { result } = renderHook(() => useAssignItem(source(refetch), jest.fn()));
    await act(async () => {
      result.current.send(ME, { [ME]: 1 });
    });
    expect(result.current.message).toEqual({ text: GROUP_ERROR_COPY.busy, retry: false });
    expect(GROUP_ERROR_COPY.busy).toBe("That didn't go through. Please try again.");
    expect(result.current.busy).toBeNull();
    expect(refetch).not.toHaveBeenCalled();
  });

  it('an error outside the allow-list still reads as network', async () => {
    assignItem.mockResolvedValue({ ok: false, error: 'group_changed' });
    const { result } = renderHook(() => useAssignItem(source(), jest.fn()));
    await act(async () => {
      result.current.send(ME, { [ME]: 1 });
    });
    expect(result.current.message).toEqual({ text: GROUP_ERROR_COPY.network, retry: false });
  });
});
