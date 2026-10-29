import { MediaPayloadSchema } from '../lib/view-schemas.js';
import './agent-media.css';

export function mountAgentMedia(root, rawPayload, view, app, initialHost) {
  const payload = MediaPayloadSchema.parse(rawPayload);
  const origin = new URL(payload.mediaOrigin);
  if (
    origin.protocol !== 'https:' &&
    !(
      origin.protocol === 'http:' &&
      ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname)
    )
  )
    throw new Error('Invalid media origin.');
  for (const item of payload.artifacts)
    for (const url of [item.previewUrl, item.saveUrl]) {
      const parsed = new URL(url);
      if (
        parsed.origin !== origin.origin ||
        !/^\/preview\/[A-Za-z0-9_-]{43}$/.test(parsed.pathname)
      )
        throw new Error('Invalid preview URL.');
    }
  const images = payload.artifacts.filter((item) => item.type === 'image'),
    videos = payload.artifacts.filter((item) => item.type === 'video');
  let selected = 0,
    videoIndex = 0,
    tab = images.length ? 'image' : 'video',
    scale = 0,
    dead = false,
    host = initialHost ?? {};
  root.innerHTML = `<header class="media-heading"><span class="media-brand" aria-hidden="true"><svg viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="15" rx="2"/><path d="m3 16 5-5 5 6 3-3 5 5M8 2h8"/><circle cx="16" cy="10" r="1.5"/></svg></span><div><h1>Agent captures</h1><p data-role="website"></p></div><span class="media-count" data-role="count"></span></header>
  <nav class="media-tabs" role="tablist" aria-label="Captured media"><button data-role="images" role="tab">Screenshots</button><button data-role="videos" role="tab">Recordings</button></nav>
  <section class="media-stage" data-role="stage" aria-label="Selected capture"><img data-role="image" alt=""/><video data-role="video" controls playsinline preload="metadata" aria-label="Captured browser recording"></video><div class="media-message" data-role="message" role="status" hidden><strong data-role="title"></strong><p data-role="detail"></p><button data-role="retry">Retry loading</button></div></section>
  <div class="media-toolbar" aria-label="Capture controls"><button data-role="previous" aria-label="Previous capture">‹</button><button data-role="next" aria-label="Next capture">›</button><span class="media-position" data-role="position"></span><button data-role="fit" aria-label="Fit screenshot">Fit</button><button data-role="zoom" aria-label="Zoom screenshot">+</button><a class="media-save" data-role="save" target="_blank" rel="noreferrer">Save</a><button data-role="fullscreen" aria-label="Enter fullscreen">⛶</button></div>
  <div class="media-gallery" data-role="gallery" aria-label="Screenshot gallery"></div><p class="media-caption"><strong data-role="label"></strong><span data-role="rationale"></span></p><p class="media-details" data-role="details"></p><footer><span>Captured output · Read only</span><span>Browserless</span></footer>`;
  const $ = (role) => root.querySelector(`[data-role="${role}"]`);
  const current = () =>
    tab === 'image' ? images[selected] : videos[videoIndex];
  const clearSources = () => {
    $('video').pause();
    $('video').removeAttribute('src');
    $('video').removeAttribute('poster');
    $('video').load();
    $('image').removeAttribute('src');
  };
  function error(title, detail, retry = true) {
    $('message').hidden = false;
    $('title').textContent = title;
    $('detail').textContent = detail;
    $('retry').hidden = !retry;
    $('save').hidden = true;
  }
  function updateHost(context) {
    host = { ...host, ...context };
    root.classList.toggle('expanded', host.displayMode === 'fullscreen');
    $('fullscreen').hidden =
      !host.availableDisplayModes?.includes('fullscreen') &&
      !document.fullscreenEnabled;
    $('fullscreen').setAttribute(
      'aria-label',
      host.displayMode === 'fullscreen' || document.fullscreenElement
        ? 'Exit fullscreen'
        : 'Enter fullscreen',
    );
  }
  function render() {
    if (dead) return;
    const item = current(),
      video = tab === 'video',
      index = video ? videoIndex : selected,
      total = video ? videos.length : images.length;
    $('message').hidden = true;
    $('save').hidden = false;
    $('save').href = item.saveUrl;
    $('images').hidden = !images.length;
    $('videos').hidden = !videos.length;
    $('images').textContent = `Screenshots (${images.length})`;
    $('videos').textContent = `Recordings (${videos.length})`;
    $('images').setAttribute('aria-selected', String(!video));
    $('videos').setAttribute('aria-selected', String(video));
    $('website').textContent =
      item.website || view.data.website || 'Captured browser output';
    $('count').textContent =
      `${images.length} images · ${videos.length} videos`;
    $('count').hidden = payload.artifacts.length === 1;
    root.querySelector('.media-tabs').hidden = payload.artifacts.length === 1;
    $('label').textContent = item.label;
    $('rationale').textContent = item.rationale;
    $('details').textContent =
      `${item.mimeType} · ${Math.round(item.bytes / 1024)} KB${item.width && item.height ? ` · ${item.width} × ${item.height}` : ''} · Command ${item.commandIndex}`;
    $('image').hidden = video;
    $('video').hidden = !video;
    $('stage').classList.toggle('zoomed', !video && scale > 0);
    if (video) {
      if ($('video').getAttribute('src') !== item.previewUrl)
        $('video').src = item.previewUrl;
    } else {
      $('video').pause();
      $('image').src = item.previewUrl;
      $('image').alt = item.label;
      $('image').style.width = scale
        ? `${(item.width || $('image').naturalWidth || 1000) * scale}px`
        : '100%';
    }
    $('position').textContent = `${index + 1} / ${total}`;
    for (const role of ['previous', 'next', 'position'])
      $(role).hidden = total === 1;
    $('previous').disabled = index === 0;
    $('next').disabled = index === total - 1;
    $('fit').hidden = video;
    $('zoom').hidden = video;
    $('gallery').hidden = video || images.length === 1;
    $('gallery').replaceChildren(
      ...images.map((asset, index) => {
        const button = document.createElement('button');
        button.className = 'media-thumb';
        button.setAttribute('aria-current', String(index === selected));
        button.setAttribute('aria-label', `View ${asset.label}`);
        const image = document.createElement('img');
        image.src = asset.previewUrl;
        image.alt = '';
        const label = document.createElement('span');
        label.textContent = `${index + 1} · ${asset.label}`;
        image.onerror = () => {
          label.textContent = `${index + 1} · Unavailable`;
        };
        button.append(image, label);
        button.onclick = () => {
          selected = index;
          scale = 0;
          render();
        };
        return button;
      }),
    );
  }
  const move = (delta) => {
    if (tab === 'video')
      videoIndex = Math.max(0, Math.min(videos.length - 1, videoIndex + delta));
    else selected = Math.max(0, Math.min(images.length - 1, selected + delta));
    scale = 0;
    render();
  };
  $('images').onclick = () => {
    tab = 'image';
    scale = 0;
    render();
  };
  $('videos').onclick = () => {
    tab = 'video';
    scale = 0;
    render();
  };
  $('previous').onclick = () => move(-1);
  $('next').onclick = () => move(1);
  $('fit').onclick = () => {
    scale = 0;
    render();
  };
  $('zoom').onclick = () => {
    scale = scale ? Math.min(2, scale + 0.5) : 1;
    render();
  };
  $('retry').onclick = () => {
    (tab === 'video' ? $('video') : $('image')).removeAttribute('src');
    render();
  };
  const failed = () => {
    if (!dead)
      error(
        'Capture unavailable',
        'Try another item or retry loading the stored capture. The original download remains separate.',
      );
  };
  $('image').onerror = failed;
  $('video').onerror = failed;
  $('fullscreen').onclick = async () => {
    try {
      if (host.availableDisplayModes?.includes('fullscreen')) {
        const result = await app.requestDisplayMode({
          mode: host.displayMode === 'fullscreen' ? 'inline' : 'fullscreen',
        });
        updateHost({ displayMode: result.mode });
      } else if (document.fullscreenElement) await document.exitFullscreen();
      else await root.requestFullscreen();
    } catch {
      $('fullscreen').hidden = true;
    }
  };
  const keydown = (event) => {
    if (dead || event.target.matches('video,input,select')) return;
    if (['ArrowLeft', 'ArrowRight'].includes(event.key)) {
      event.preventDefault();
      move(event.key === 'ArrowRight' ? 1 : -1);
    }
  };
  root.addEventListener('keydown', keydown);
  render();
  updateHost(host);
  return {
    updateHost,
    fail(cause) {
      dead = true;
      clearSources();
      $('gallery').replaceChildren();
      for (const button of root.querySelectorAll('button'))
        button.disabled = true;
      error(
        'Media unavailable',
        `${cause.message} Use the original download instructions when available.`,
        false,
      );
    },
    dispose() {
      dead = true;
      clearSources();
      root.removeEventListener('keydown', keydown);
      root.replaceChildren();
    },
  };
}
