# Benchmark p4-before (desktop)

2026-11-13T05:27:14.973Z · 4× Intel(R) Xeon(R) Processor @ 2.10GHz · 17 GB · Chromium headless

## B0

| metrik | nilai |
|---|---|
| impor · import_visible_p95_ms | 122.7 |
| impor · upload_ms | 794.3 |
| impor · upload_mbps | 927.7 |
| impor · asset_ready_ms | 11604 |
| impor · until_steady_ms | 12075 |
| impor · wait_after_upload_ms | 11658 |
| putar · seconds | 15 |
| putar · fps_rendered | 30 |
| putar · frames_missed_pct | 0 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 6 |
| putar · frame_draw_p95_ms | 8.6 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 37.2 / 41 / 41 (n=20) |
| ekspor · state | done |
| ekspor · wall_ms | 24239 |
| ekspor · mode | fast |
| ekspor · fetch_media_ms | 0 |
| ekspor · prepare_ms | 1220 |
| ekspor · decode_ms | 3516 |
| ekspor · composite_ms | 18624 |
| ekspor · encode_ms | 353 |
| ekspor · mux_ms | 51 |
| ekspor · total_ms | 23816 |
| ekspor · realtime_factor | 2.52 |
| ekspor · encoder_queue_max | 5 |
| ekspor · output_size | 47990773 |
| ekspor · renderer_rss_start_mb | 737 |
| ekspor · renderer_rss_peak_mb | 1136 |
| ekspor · js_heap_peak_mb | 140 |
| ekspor · probe | {"video":"h264 1920x1080 30/1","audio":"opus","duration":60,"audio_mean_db":-18.1,"audio_max_db":-10.9} |

## B3

| metrik | nilai |
|---|---|
| proyek | 62 klip · 600 dtk |
| putar · seconds | 10 |
| putar · fps_rendered | 30.1 |
| putar · frames_missed_pct | 0 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 6.9 |
| putar · frame_draw_p95_ms | 9.7 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 1 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 53.1 / 57.2 / 59.3 (n=30) |
| ekspor · range_s | 120 |
| ekspor · size | 95562225 |
| ekspor · seconds | 48.394 |
| ekspor · mode | fast |
| ekspor · probe | {"video":"h264 1920x1080 30/1","audio":"opus","duration":120,"audio_mean_db":-16.3,"audio_max_db":-8.5} |
| ekspor · prepare_ms | 5999 |
| ekspor · fetch_media_ms | 0 |
| ekspor · decode_ms | 6632 |
| ekspor · composite_ms | 35174 |
| ekspor · encode_ms | 474 |
| ekspor · mux_ms | 90 |
| ekspor · realtime_factor | 2.48 |
| ekspor · encoder_queue_max | 2 |
| ekspor · renderer_rss_start_mb | 1015 |
| ekspor · renderer_rss_peak_mb | 2667 |
| ekspor · js_heap_peak_mb | 690 |
