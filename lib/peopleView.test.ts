// Screen copy and "On this bill" rows for the People card and the Add people screen.
// Spec: docs/specs/2026-11-24-people-and-invites.md (D6; Tasks 6 and 7).
import { fakeMark, fakePayment } from '@/test-utils/fakes';

import { makeNameOf } from './billView';
import type { BillData, BillMember } from './bills';
import {
  addedText,
  leaveBlockedText,
  noMatchesText,
  onlyHostText,
  onThisBillRows,
  PEOPLE_COPY,
  removedText,
  showSearch,
} from './peopleView';

const HOST = '00000000-0000-4000-8000-00000000000a';
const SAM = '00000000-0000-4000-8000-00000000000b';
const CY = '00000000-0000-4000-8000-00000000000c';
const DEE = '00000000-0000-4000-8000-00000000000d';
const ROW = '22222222-0000-4000-8000-000000000001';

const member = (userId: string, displayName: string | null, mark: BillMember['mark'] = null): BillMember => ({
  userId,
  displayName,
  venmoUsername: null,
  mark,
  notReceived: null,
});

function bill(
  participants: BillMember[],
  claims: { line_item_id: string; user_id: string; parts: number }[] = [],
  payerId = HOST,
  payers: BillData['payers'] = [],
): BillData {
  // Test double: only the fields these helpers read are meaningful.
  return {
    bill: { id: 'b', host_id: HOST, payer_id: payerId } as unknown as BillData['bill'],
    rows: [],
    participants,
    claims,
    // Who paid A1.4: L3 reads the ledger. Each hand-built mark becomes the entry 4a's copy would make.
    payers,
    payments: participants.flatMap((p) =>
      p.mark ? [fakePayment(p.userId, p.userId, p.mark.toUserId, p.mark.cents, p.mark.at, p.mark.method)] : [],
    ),
    flags: [],
  };
}

describe('showSearch (PI-9)', () => {
  it('shows the search field only with more than 5 people', () => {
    expect(showSearch(0)).toBe(false);
    expect(showSearch(5)).toBe(false);
    expect(showSearch(6)).toBe(true);
  });
});

describe('sentences', () => {
  it('noMatchesText quotes the trimmed query', () => {
    expect(noMatchesText('zzz')).toBe('No one matches "zzz".');
    expect(noMatchesText('  sam  ')).toBe('No one matches "sam".');
  });

  it('noMatchesText cuts the query to the 50 characters search uses', () => {
    expect(noMatchesText('a'.repeat(60))).toBe(`No one matches "${'a'.repeat(50)}".`);
  });

  it('onlyHostText names the host, or says "the host" when they have no name', () => {
    expect(onlyHostText('Hana Lee')).toBe('Only Hana Lee can add people.');
    expect(onlyHostText('  Hana  ')).toBe('Only Hana can add people.');
    expect(onlyHostText(null)).toBe('Only the host can add people.');
    expect(onlyHostText('   ')).toBe('Only the host can add people.');
  });

  it('added and removed announcements', () => {
    expect(addedText('Sam Lee')).toBe('Sam Lee added');
    expect(removedText('Sam Lee')).toBe('Sam Lee removed');
  });

  it('copy fixed by the spec', () => {
    expect(PEOPLE_COPY.emptyProfile).toBe('People you split bills with will show up here.');
    expect(PEOPLE_COPY.emptyAdd).toBe(
      'People you split bills with will show up here. To invite someone new, go back and share the link.',
    );
    expect(PEOPLE_COPY.everyoneOn).toBe("Everyone you've split with is on this bill.");
    expect(PEOPLE_COPY.leaveConfirm).toBe("Leave this bill? You'll stop seeing it. You can rejoin with the link.");
  });
});

describe('onThisBillRows', () => {
  it('puts the viewer first as "You", then the others in join order', () => {
    const data = bill([member(SAM, 'Sam Lee'), member(HOST, 'Hana'), member(CY, 'Cy')]);
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows.map((r) => r.name)).toEqual(['You', 'Sam Lee', 'Cy']);
  });

  it('marks people with no claims as "No items yet", the viewer included, and says it in the label', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam Lee'), member(CY, 'Cy')], [{ line_item_id: ROW, user_id: CY, parts: 1 }]);
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows.map((r) => [r.name, r.noItems, r.a11yLabel])).toEqual([
      ['You', true, 'You, no items yet'],
      ['Sam Lee', true, 'Sam Lee, no items yet'],
      ['Cy', false, 'Cy'],
    ]);
  });

  it('removable follows canRemove: M3 yes; the payer (M2), a claimer (M5), a mark (M7) and the host (M1) no', () => {
    const data = bill(
      [
        member(HOST, 'Hana'),
        member(SAM, 'Sam'),
        member(CY, 'Cy'),
        member(DEE, 'Dee', fakeMark(100, '2026-11-20T19:00:00Z', HOST)),
        member('00000000-0000-4000-8000-00000000000e', 'Eve'),
      ],
      [{ line_item_id: ROW, user_id: CY, parts: 1 }],
      '00000000-0000-4000-8000-00000000000e',
    );
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(Object.fromEntries(rows.map((r) => [r.name, r.removable]))).toEqual({
      You: false,
      Sam: true,
      Cy: false,
      Dee: false,
      Eve: false,
    });
  });

  it('a guest viewer can remove no one', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam'), member(CY, 'Cy')]);
    const rows = onThisBillRows(data, SAM, makeNameOf(data.participants, SAM));
    expect(rows.map((r) => r.removable)).toEqual([false, false, false]);
    expect(rows[0]?.name).toBe('You');
  });

  it('a person with no name reads "A friend"', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, null)]);
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows[1]?.name).toBe('A friend');
  });
});

// Who paid S12 (docs/specs/2026-11-26-who-paid.md A1.5): a payer can't be removed and can't leave,
// and the reason shows before any tap.
describe('payers: the reason Remove and Leave are missing (S12)', () => {
  const split = (lead: string, other: string) => [
    { userId: lead, paidCents: 6000 },
    { userId: other, paidCents: 4021 },
  ];

  it('host view: a co-payer gets the spec line instead of Remove, and the label says it', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam'), member(CY, 'Cy')], [], HOST, split(HOST, SAM));
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows.map((r) => [r.name, r.removable, r.payerNote, r.a11yLabel])).toEqual([
      ['You', false, null, 'You, no items yet'],
      ['Sam', false, 'Sam paid part of the bill. Change who paid first.', 'Sam, no items yet. Sam paid part of the bill. Change who paid first.'],
      ['Cy', true, null, 'Cy, no items yet'],
    ]);
  });

  it('host view: the one payer (not the host) gets the one-person line; a payer with claims still gets it', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam')], [{ line_item_id: ROW, user_id: SAM, parts: 1 }], SAM);
    const row = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST))[1];
    expect(row).toMatchObject({ removable: false, payerNote: 'Sam paid the bill. Change who paid first.', a11yLabel: 'Sam. Sam paid the bill. Change who paid first.' });
  });

  it('the host, as a payer, never gets a note (the host is never removable anyway)', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam')], [], SAM, split(SAM, HOST));
    const rows = onThisBillRows(data, HOST, makeNameOf(data.participants, HOST));
    expect(rows[0]).toMatchObject({ name: 'You', payerNote: null });
    expect(rows[1]?.payerNote).toBe('Sam paid part of the bill. Change who paid first.');
  });

  it('a guest viewer gets no notes (only the host removes)', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam'), member(CY, 'Cy')], [], HOST, split(HOST, CY));
    const rows = onThisBillRows(data, SAM, makeNameOf(data.participants, SAM));
    expect(rows.map((r) => r.payerNote)).toEqual([null, null, null]);
  });

  it('leaveBlockedText: a co-payer gets the spec line, naming the host', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam')], [], HOST, split(HOST, SAM));
    expect(leaveBlockedText(data, SAM)).toBe(
      "You're one of the people who paid. Ask Hana to change who paid before you leave.",
    );
  });

  it('leaveBlockedText: the one payer gets the one-person line', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam')], [], SAM);
    expect(leaveBlockedText(data, SAM)).toBe('You paid the bill. Ask Hana to change who paid before you leave.');
  });

  it('leaveBlockedText: null for a non-payer, for the host, and for someone not on the bill', () => {
    const data = bill([member(HOST, 'Hana'), member(SAM, 'Sam'), member(CY, 'Cy')], [], HOST, split(HOST, SAM));
    expect(leaveBlockedText(data, CY)).toBeNull();
    expect(leaveBlockedText(data, HOST)).toBeNull();
    expect(leaveBlockedText(data, DEE)).toBeNull();
  });

  it('a host with no name reads "the host"', () => {
    const data = bill([member(HOST, null), member(SAM, 'Sam')], [], HOST, split(HOST, SAM));
    expect(leaveBlockedText(data, SAM)).toBe(
      "You're one of the people who paid. Ask the host to change who paid before you leave.",
    );
  });
});
