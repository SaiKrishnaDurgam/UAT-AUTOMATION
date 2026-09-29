// WebdriverIO injects `browser` as a global at runtime.
// eslint-disable-next-line no-var
declare var browser: any;

import { loadEventConfig } from '../../utils/eventLoader';
import { debugFireTvScheduleBoxingAndPpvTile } from '../../pages/android/AndroidSchedulePage';

describe('Fire TV Schedule page debug', () => {
  it('checks PPV date and opens the configured PPV tile from selected Boxing', async () => {
    const event = loadEventConfig();
    await debugFireTvScheduleBoxingAndPpvTile(browser, event.PPV_NAME, event);
  });
});