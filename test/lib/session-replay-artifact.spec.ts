import { expect } from 'chai';

import { buildReplayHtml } from '../../src/lib/session-replay-artifact.js';

const artifact = (events: unknown[]) => ({
  sessionId: 'sr_1',
  website: 'https://example.com/page',
  timestamp: 1700000000,
  events,
});

const twoEvents = [
  { type: 4, timestamp: 1700000000000, data: {} },
  { type: 2, timestamp: 1700000006000, data: {} },
];

describe('buildReplayHtml', () => {
  it('renders the toolbar chrome the dashboard uses', () => {
    const html = buildReplayHtml(artifact(twoEvents));

    expect(html).to.include('sr_1');
    expect(html).to.include('example.com');
    expect(html).to.include('id="download"');
    expect(html).to.include('id="seek"');
    expect(html).to.include('id="toggle"');
  });

  // rrweb's controller was replaced by our toolbar; leaving it on shows two.
  it("turns off rrweb's own controller", () => {
    expect(buildReplayHtml(artifact(twoEvents))).to.include(
      'showController: false',
    );
  });

  // Shipped as "NaN:NaN": rrweb's metadata is NaN when timestamps are missing,
  // so the duration is derived from the events instead.
  it('derives duration from event timestamps and never prints NaN', () => {
    const html = buildReplayHtml(artifact(twoEvents));

    expect(html).to.include('isFinite');
    expect(html).to.not.include('NaN:NaN');
    expect(html).to.include('Math.max.apply');
  });

  it('escapes a closing script tag inside the embedded events', () => {
    const html = buildReplayHtml(
      artifact([{ type: 3, timestamp: 1, data: { text: '</script><b>x' } }]),
    );

    expect(html).to.not.include('</script><b>x');
    expect(html).to.include('<\\/script');
  });

  it('escapes html in the session id and host', () => {
    const html = buildReplayHtml({
      sessionId: '<img src=x onerror=alert(1)>',
      website: 'https://example.com',
      timestamp: 0,
      events: twoEvents,
    });

    expect(html).to.include('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).to.not.include('<span class="chip mono"><img');
  });
  it('autoplays, since a replay is opened to be watched', () => {
    expect(buildReplayHtml(artifact(twoEvents))).to.include('autoPlay: true');
  });

  // The `hidden` attribute on an SVG loses to rrweb-player's stylesheet, which
  // showed both glyphs at once — visibility is driven by a class on the button.
  it('shows exactly one transport glyph at a time', () => {
    const html = buildReplayHtml(artifact(twoEvents));

    expect(html).to.include('#toggle #icon-pause { display: none; }');
    expect(html).to.include('#toggle.playing #icon-play { display: none; }');
    expect(html).to.not.include('hidden aria-hidden');
  });
  // A grey track token resolves to the panel colour in dark mode and disappears;
  // the dashboard derives its track from the accent (bg-primary/20).
  it('derives the seek track from the accent so it shows in dark mode', () => {
    const html = buildReplayHtml(artifact(twoEvents));

    expect(html).to.include('--track: hsl(238.7324 83.5294% 66.6667% / 0.2)');
    expect(html).to.include('--track: hsl(234.4538 89.4737% 73.9216% / 0.2)');
  });
});
