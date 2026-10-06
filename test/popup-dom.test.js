// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import { ObjectPopup, rowsKey } from '../src/objects/popup.js';

describe('popup info rows keep label and value together', () => {
  it('the key includes info labels', () => {
    expect(rowsKey([{ kind: 'info', label: 'Rain', value: 'Dry' }])).not.toBe(rowsKey([{ kind: 'info', label: 'Wifi', value: 'Dry' }]));
  });
  it('rows that change their labels are rebuilt', () => {
    const root = document.createElement('div');
    document.body.append(root);
    let extra = [{ label: 'Rain', value: 'Dry' }, { label: 'Wifi', value: '-61 dBm' }];
    const states = { 'sensor.x': { entity_id: 'sensor.x', state: '5', attributes: {} } };
    const p = new ObjectPopup(root, {
      resolve: () => ({ obj: { id: 'o', type: 'other', label: 'O', ui: { popup: ['state'] } }, chain: { entities: ['sensor.x'], lit: false }, states, groups: {}, extra }),
    });
    p.open({ id: 'o', label: 'O' }, null);
    const rows = () => [...root.querySelectorAll('.fp-pop-row')].map((r) => r.textContent.replace(/\s+/g, '').trim());
    expect(rows().slice(-2)).toEqual(['RainDry', 'Wifi-61dBm']);
    extra = [{ label: 'Offline', value: 'since 3 min' }, { label: 'Rain', value: 'Dry' }];
    p.update();
    expect(rows().slice(-2)).toEqual(['Offlinesince3min', 'RainDry']);
    p.close();
  });
});
