# Benchmark p4-after (desktop)

2026-11-13T05:30:38.141Z · 4× Intel(R) Xeon(R) Processor @ 2.10GHz · 17 GB · Chromium headless

## B0

| metrik | nilai |
|---|---|
| impor · import_visible_p95_ms | 127.3 |
| impor · upload_ms | 760.4 |
| impor · upload_mbps | 969 |
| impor · asset_ready_ms | 11549.6 |
| impor · until_steady_ms | 12010 |
| impor · wait_after_upload_ms | 11651 |
| putar · seconds | 15 |
| putar · fps_rendered | 30.1 |
| putar · frames_missed_pct | 2.7 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 6.4 |
| putar · frame_draw_p95_ms | 9 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 39.1 / 40.8 / 40.8 (n=20) |
| ekspor · state | done |
| ekspor · wall_ms | 24095 |
| ekspor · mode | fast |
| ekspor · spool | opfs |
| ekspor · audio_decoded_s | 120 |
| ekspor · fetch_media_ms | 0 |
| ekspor · prepare_ms | 1898 |
| ekspor · decode_ms | 3653 |
| ekspor · composite_ms | 17579 |
| ekspor · encode_ms | 339 |
| ekspor · mux_ms | 27 |
| ekspor · total_ms | 23550 |
| ekspor · realtime_factor | 2.55 |
| ekspor · encoder_queue_max | 4 |
| ekspor · output_size | 47986593 |
| ekspor · renderer_rss_start_mb | 738 |
| ekspor · renderer_rss_peak_mb | 1049 |
| ekspor · js_heap_peak_mb | 74 |
| ekspor · probe | {"video":"h264 1920x1080 30/1","audio":"opus","duration":60,"audio_mean_db":-18.1,"audio_max_db":-10.9} |

## B3

| metrik | nilai |
|---|---|
| proyek | 62 klip · 600 dtk |
| putar · seconds | 10 |
| putar · fps_rendered | 30 |
| putar · frames_missed_pct | 3 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 6 |
| putar · frame_draw_p95_ms | 8.8 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 41 / 56.8 / 71.3 (n=30) |
| ekspor · range_s | 120 |
| ekspor · size | 95555914 |
| ekspor · seconds | 49.957 |
| ekspor · mode | fast |
| ekspor · probe | {"video":"h264 1920x1080 30/1","audio":"opus","duration":120,"audio_mean_db":-16.3,"audio_max_db":-8.5} |
| ekspor · spool | opfs |
| ekspor · audio_decoded_s | 360 |
| ekspor · prepare_ms | 9459 |
| ekspor · fetch_media_ms | 0 |
| ekspor · decode_ms | 6365 |
| ekspor · composite_ms | 33648 |
| ekspor · encode_ms | 428 |
| ekspor · mux_ms | 31 |
| ekspor · realtime_factor | 2.4 |
| ekspor · encoder_queue_max | 2 |
| ekspor · renderer_rss_start_mb | 1063 |
| ekspor · renderer_rss_peak_mb | 1287 |
| ekspor · js_heap_peak_mb | 174 |
