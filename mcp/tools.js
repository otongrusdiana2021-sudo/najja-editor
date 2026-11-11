// MCP tool definitions for Najja Editor. Execution happens inside the open editor tab (public/js/api.js).
import {
  ASPECTS, FILTERS, EFFECTS, TRANSITIONS, ANIM_IN, ANIM_OUT, ANIM_LOOP, TEXT_PRESETS, TEXT_TEMPLATES, FONTS, BLEND_MODES, RESOLUTIONS,
} from '../public/js/presets.js';

const ids = (arr) => arr.map((a) => a.id);
const str = (description, extra = {}) => ({ type: 'string', description, ...extra });
const num = (description, extra = {}) => ({ type: 'number', description, ...extra });
const bool = (description) => ({ type: 'boolean', description });
const enm = (values, description) => ({ type: 'string', enum: values, description });
const obj = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });

const TRACK = str('Target track: "main" (magnetic primary video track), "overlay" (picture-in-picture layer), "text", "audio", "new" (always create a new track) or an existing track id. Default: picked automatically by clip type.');

const POSITION = {
  x: num('Horizontal offset from canvas center as a fraction of canvas width (-0.5 left edge, 0 center, 0.5 right edge).'),
  y: num('Vertical offset from canvas center as a fraction of canvas height (-0.5 top, 0 center, 0.5 bottom).'),
  scale: num('Scale multiplier. 1 = fit to canvas for video/images, base size for text/stickers.', { minimum: 0.01, maximum: 20 }),
  rotation: num('Rotation in degrees (clockwise).'),
  opacity: num('Opacity from 0 to 1.', { minimum: 0, maximum: 1 }),
};

const ANIMATION = {
  animation_in: enm(ids(ANIM_IN), 'Entrance animation.'),
  animation_out: enm(ids(ANIM_OUT), 'Exit animation.'),
  animation_loop: enm(ids(ANIM_LOOP), 'Looping (combo) animation played for the whole clip.'),
  animation_in_duration: num('Entrance animation length in seconds (default 0.5).', { minimum: 0.05, maximum: 10 }),
  animation_out_duration: num('Exit animation length in seconds (default 0.5).', { minimum: 0.05, maximum: 10 }),
};

const TEXT_STYLE = {
  preset: enm(ids(TEXT_PRESETS), 'Text style preset. It is applied first, and any other style field below overrides it.'),
  font: enm(FONTS.map((f) => f.name), 'Font family.'),
  size: num('Font size in canvas pixels (the canvas short side is 1080). Titles are usually 110-180, captions 56-80.', { minimum: 8, maximum: 600 }),
  color: str('Text fill color as a CSS hex value, for example #ffffff.'),
  bold: bool('Bold weight.'),
  italic: bool('Italic.'),
  align: enm(['left', 'center', 'right'], 'Alignment for multi-line text.'),
  letter_spacing: num('Letter spacing in px.'),
  line_height: num('Line height multiplier (default 1.2).'),
  stroke_color: str('Outline color as a hex value.'),
  stroke_width: num('Outline width in px. 0 turns the outline off.'),
  background_color: str('Box color behind the text as a hex value, or "none" to turn the box off.'),
  background_opacity: num('Box opacity from 0 to 1.'),
  shadow: bool('Drop shadow on or off.'),
  gradient_from: str('Gradient start color. Set it together with gradient_to to use a gradient fill, or set "none" to turn the gradient off.'),
  gradient_to: str('Gradient end color.'),
};

const ADJUST = obj(Object.fromEntries(
  ['brightness', 'contrast', 'saturation', 'exposure', 'temperature', 'tint', 'hue', 'fade', 'vignette', 'blur']
    .map((k) => [k, num(k === 'hue' ? '-180..180' : (['fade', 'vignette', 'blur'].includes(k) ? '0..100' : '-100..100'))]),
));

export const TOOLS = [
  {
    name: 'get_project',
    title: 'Get project',
    description: 'Return the current project: canvas size and aspect ratio, fps, total duration, playhead, tracks, every clip (id, type, track, start, end and properties) and the media library. Call this before editing so you have the right ids.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'list_assets',
    title: 'List built-in assets',
    description: 'List the ids and names of the built-in filters, effects, transitions, in/out/loop animations, text presets, text templates, fonts, blend modes, stickers and aspect ratios.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'new_project',
    title: 'New project',
    description: 'Start a new, empty project and open it in the editor. The previous project stays saved in the browser project list.',
    inputSchema: obj({ name: str('Project name.'), aspect_ratio: enm(Object.keys(ASPECTS), 'Canvas aspect ratio. Default 16:9; use 9:16 for TikTok/Reels/Shorts.') }),
  },
  {
    name: 'set_project',
    title: 'Project settings',
    description: 'Change project settings: name, aspect ratio, frame rate and canvas background (a solid color, or a blurred copy of the main video).',
    inputSchema: obj({
      name: str('Project name.'),
      aspect_ratio: enm(Object.keys(ASPECTS), 'Canvas aspect ratio.'),
      fps: { type: 'integer', enum: [24, 25, 30, 50, 60], description: 'Frame rate.' },
      background_mode: enm(['color', 'blur'], 'Canvas background behind the main track.'),
      background_color: str('Background color as a hex value.'),
      background_blur: num('Blur strength (0-100) when background_mode is blur.'),
    }),
  },
  {
    name: 'import_media',
    title: 'Import media',
    description: 'Import a video, image or audio file into the media library from an http(s) URL or an absolute file path on the computer running the Najja server. Returns media_id, type and duration. With add_to_timeline=true it also places the file on the timeline.',
    inputSchema: obj({
      url: str('http(s) URL of the media file.'),
      path: str('Absolute local file path, for example /Users/me/Movies/clip.mp4.'),
      name: str('Display name.'),
      add_to_timeline: bool('Also add the file to the timeline (video and images go on the main track, audio on an audio track).'),
      start: num('Timeline start in seconds when add_to_timeline is true. By default it is appended to the end of the main track.'),
    }),
  },
  {
    name: 'list_media',
    title: 'List media',
    description: 'List the media library: id, name, type, duration and resolution.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'add_media_clip',
    title: 'Add media clip',
    description: 'Place a media library item (video, image or audio) on the timeline. Video and images go on the magnetic main track by default; use track="overlay" for picture-in-picture. Audio goes on an audio track.',
    inputSchema: obj({
      media_id: str('Media id from list_media or import_media.'),
      track: TRACK,
      start: num('Timeline start in seconds. On the main track the clip is inserted at that point; if omitted it is appended to the end.'),
      source_in: num('Start point inside the source file, in seconds (trims the head).'),
      duration: num('Length on the timeline in seconds. Default: the rest of the source (video/audio) or 3s (image).'),
      speed: num('Playback speed, 0.1 to 10.', { minimum: 0.1, maximum: 10 }),
      volume: num('Volume from 0 to 2 (1 = 100%).', { minimum: 0, maximum: 2 }),
      filter: enm(ids(FILTERS), 'Color filter.'),
      transition: enm(ids(TRANSITIONS), 'Main track only: transition from the previous clip into this one.'),
      ...POSITION,
      ...ANIMATION,
    }, ['media_id']),
  },
  {
    name: 'add_text',
    title: 'Add text',
    description: 'Add a text/title clip on a text track above the video. Use "\\n" for line breaks. Use template for ready-made animated title styles.',
    inputSchema: obj({
      text: str('The text content.'),
      template: enm(ids(TEXT_TEMPLATES), 'Optional animated title template (sets preset, size and animations).'),
      start: num('Start time in seconds (default: the playhead).'),
      duration: num('Duration in seconds (default 3).'),
      track: TRACK,
      ...TEXT_STYLE,
      ...POSITION,
      ...ANIMATION,
    }, ['text']),
  },
  {
    name: 'add_subtitles',
    title: 'Add subtitles',
    description: 'Add many timed caption clips at once, for example generated from a transcript. Each item becomes its own text clip on a shared subtitle track.',
    inputSchema: obj({
      items: {
        type: 'array',
        description: 'Caption lines with start and end times in seconds.',
        items: obj({ start: num('Start time (s).'), end: num('End time (s).'), text: str('Caption text.') }, ['start', 'end', 'text']),
      },
      preset: enm(ids(TEXT_PRESETS), 'Style preset (default "subtitle").'),
      y: num('Vertical position as a fraction from center (default 0.36, near the bottom).'),
      size: num('Font size (default 64).'),
      font: enm(FONTS.map((f) => f.name), 'Font family.'),
      color: str('Text color.'),
      animation_in: enm(ids(ANIM_IN), 'Entrance animation applied to every caption.'),
      replace_existing: bool('Delete the existing subtitle track first.'),
    }, ['items']),
  },
  {
    name: 'add_sticker',
    title: 'Add sticker',
    description: 'Add an emoji sticker, or a label badge such as SUBSCRIBE or SALE, as an overlay.',
    inputSchema: obj({
      emoji: str('Emoji character to use as the sticker, for example 🔥.'),
      badge_text: str('Use this instead of emoji to make a rounded label badge with this text.'),
      badge_color: str('Badge background color (hex).'),
      badge_text_color: str('Badge text color (hex).'),
      start: num('Start time in seconds (default: the playhead).'),
      duration: num('Duration in seconds (default 3).'),
      ...POSITION,
      ...ANIMATION,
    }),
  },
  {
    name: 'add_solid',
    title: 'Add color background',
    description: 'Add a solid-color or gradient clip, useful as a background or a title card. It goes on the main track by default.',
    inputSchema: obj({
      color: str('Color as a hex value.'),
      color2: str('Optional second color, which makes a gradient.'),
      angle: num('Gradient angle in degrees (default 135).'),
      start: num('Start time in seconds (main track: insertion point).'),
      duration: num('Duration in seconds (default 3).'),
      track: TRACK,
    }, ['color']),
  },
  {
    name: 'add_effect',
    title: 'Add video effect',
    description: 'Add a full-frame video effect (glitch, shake, VHS, snow, confetti and more) on an effect track. It applies to everything under it while it is active.',
    inputSchema: obj({
      effect: enm(ids(EFFECTS), 'Effect id.'),
      start: num('Start time in seconds (default: the playhead).'),
      duration: num('Duration in seconds (default 3).'),
      intensity: num('Strength from 0 to 1 (default 0.7).', { minimum: 0, maximum: 1 }),
    }, ['effect']),
  },
  {
    name: 'update_clip',
    title: 'Update clip',
    description: 'Change any property of an existing clip: timing, transform, volume, speed, text and text style, filter, color adjustments, animations, transition, effect intensity or solid colors. Only the fields you pass are changed.',
    inputSchema: obj({
      clip_id: str('Clip id.'),
      start: num('New start time (s). On the magnetic main track use move_clip to reorder instead.'),
      duration: num('New duration on the timeline (s).'),
      source_in: num('New in-point inside the source (s).'),
      speed: num('Playback speed 0.1-10.'),
      volume: num('Volume from 0 to 2.'),
      muted: bool('Mute this clip.'),
      fade_in: num('Audio fade-in (s).'),
      fade_out: num('Audio fade-out (s).'),
      ...POSITION,
      flip_h: bool('Mirror horizontally.'),
      flip_v: bool('Flip vertically.'),
      blend_mode: enm(ids(BLEND_MODES), 'Layer blend mode.'),
      crop_left: num('Crop 0-0.9 (fraction).'), crop_right: num('Crop 0-0.9.'), crop_top: num('Crop 0-0.9.'), crop_bottom: num('Crop 0-0.9.'),
      text: str('New text content (text clips).'),
      ...TEXT_STYLE,
      filter: enm(ids(FILTERS), 'Color filter.'),
      filter_intensity: num('Filter strength from 0 to 1.'),
      adjust: { ...ADJUST, description: 'Color adjustments; only the keys you pass change.' },
      ...ANIMATION,
      transition: enm(ids(TRANSITIONS), 'Main track: transition into this clip from the previous clip.'),
      transition_duration: num('Transition length (s).'),
      effect: enm(ids(EFFECTS), 'Effect clips: change the effect type.'),
      intensity: num('Effect clips: strength 0-1.'),
      color: str('Solid clips: color. Sticker badges: background color.'),
      color2: str('Solid clips: second gradient color ("none" for a plain color).'),
      name: str('Clip label shown on the timeline.'),
    }, ['clip_id']),
  },
  {
    name: 'apply_filter',
    title: 'Apply filter',
    description: 'Apply a color filter to one clip, or to every visual clip on the main track with clip_id="all".',
    inputSchema: obj({
      clip_id: str('Clip id, or "all" for every main-track clip.'),
      filter: enm(ids(FILTERS), 'Filter id ("none" removes it).'),
      intensity: num('Strength from 0 to 1 (default 1).'),
    }, ['clip_id', 'filter']),
  },
  {
    name: 'apply_transition',
    title: 'Apply transition',
    description: 'Set the transition between a main-track clip and the clip before it. Use clip_id="all" to put the same transition between every pair of main-track clips.',
    inputSchema: obj({
      clip_id: str('The clip the transition leads into (it must have a clip before it on the main track), or "all".'),
      transition: enm(ids(TRANSITIONS), 'Transition id ("none" removes it).'),
      duration: num('Length in seconds (default 0.6).', { minimum: 0.1, maximum: 5 }),
    }, ['clip_id', 'transition']),
  },
  {
    name: 'split_clip',
    title: 'Split clip',
    description: 'Split a clip into two at a given timeline time. Returns both clip ids. If clip_id is omitted, every clip under that time is split.',
    inputSchema: obj({ clip_id: str('Clip id.'), time: num('Timeline time in seconds where the cut goes (default: the playhead).') }),
  },
  {
    name: 'delete_clip',
    title: 'Delete clips',
    description: 'Delete one or more clips. On the magnetic main track the clips after them close the gap.',
    inputSchema: obj({ clip_id: str('Clip id.'), clip_ids: { type: 'array', items: { type: 'string' }, description: 'Several clip ids.' } }),
    annotations: { destructiveHint: true },
  },
  {
    name: 'move_clip',
    title: 'Move clip',
    description: 'Move a clip to a new start time and/or a different track. On the main track this reorders the clip.',
    inputSchema: obj({ clip_id: str('Clip id.'), start: num('New start time (s).'), track: TRACK }, ['clip_id']),
  },
  {
    name: 'duplicate_clip',
    title: 'Duplicate clip',
    description: 'Duplicate a clip. The copy goes right after the original, or at start if given.',
    inputSchema: obj({ clip_id: str('Clip id.'), start: num('Start time for the copy (s).') }, ['clip_id']),
  },
  {
    name: 'playback',
    title: 'Playback',
    description: 'Control the preview player: play, pause, stop (pause and go back to 0) or seek to a time.',
    inputSchema: obj({ action: enm(['play', 'pause', 'stop', 'seek'], 'Action.'), time: num('Seek time in seconds (for seek).') }, ['action']),
  },
  {
    name: 'get_frame',
    title: 'Capture preview frame',
    description: 'Render the composed video at a given time and return it as an image so you can check the result (layout, text, colors). It waits until every visible video shows its frame for that exact time; if a video is still loading after about 20 seconds the result lists it in stale_video, and calling again gives the exact frame.',
    inputSchema: obj({
      time: num('Time in seconds (default: the playhead).'),
      max_width: num('Maximum image width in px (default 960).', { minimum: 64, maximum: 3840 }),
      format: enm(['jpeg', 'png'], 'Image format (default jpeg).'),
    }),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'history',
    title: 'Undo / redo',
    description: 'Undo or redo the last edit.',
    inputSchema: obj({ action: enm(['undo', 'redo'], 'Action.'), steps: num('How many steps (default 1).', { minimum: 1, maximum: 50 }) }, ['action']),
  },
  {
    name: 'export_video',
    title: 'Export video',
    description: 'Render the project to a video file in the browser and save it into the server exports folder. MP4 renders faster than real time where the browser supports WebCodecs (Chrome/Edge), otherwise in real time. Returns right away; poll get_export_status for progress and the saved file path. Keep the editor tab open while it renders.',
    inputSchema: obj({
      resolution: enm(Object.keys(RESOLUTIONS), 'Short-side resolution (default 1080p).'),
      fps: { type: 'integer', enum: [24, 25, 30, 50, 60], description: 'Frame rate (default: the project fps).' },
      format: enm(['mp4', 'webm'], 'Container. mp4 is used when the browser supports it, otherwise it falls back to webm.'),
      quality: enm(['low', 'recommended', 'high'], 'Bitrate preset (default recommended).'),
      filename: str('Output file name without extension.'),
    }),
  },
  {
    name: 'get_export_status',
    title: 'Export status',
    description: 'Progress of the current or last export: state, percent, and once done, the saved file path and size.',
    inputSchema: obj({}),
    annotations: { readOnlyHint: true },
  },
];
