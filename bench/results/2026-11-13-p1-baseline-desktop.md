# Benchmark p1-baseline (desktop)

2026-11-13T04:27:24.574Z · 4× Intel(R) Xeon(R) Processor @ 2.10GHz · 17 GB · Chromium headless

## B0

| metrik | nilai |
|---|---|
| impor · import_visible_p95_ms | 166.7 |
| impor · upload_ms | 805.6 |
| impor · upload_mbps | 914.6 |
| impor · asset_ready_ms | 10043.9 |
| impor · until_steady_ms | 10455 |
| impor · wait_after_upload_ms | 10237 |
| putar · seconds | 15 |
| putar · fps_rendered | 30.1 |
| putar · frames_missed_pct | 0 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 5.9 |
| putar · frame_draw_p95_ms | 8.5 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 24.5 / 41 / 41 (n=20) |
| ekspor · state | done |
| ekspor · wall_ms | 21471 |
| ekspor · mode | fast |
| ekspor · fetch_media_ms | 0 |
| ekspor · prepare_ms | 1218 |
| ekspor · decode_ms | 3175 |
| ekspor · composite_ms | 16196 |
| ekspor · encode_ms | 363 |
| ekspor · mux_ms | 44 |
| ekspor · total_ms | 21038 |
| ekspor · realtime_factor | 2.85 |
| ekspor · encoder_queue_max | 5 |
| ekspor · output_size | 47994724 |
| ekspor · renderer_rss_start_mb | 741 |
| ekspor · renderer_rss_peak_mb | 1141 |
| ekspor · js_heap_peak_mb | 142 |
| ekspor · probe | {"video":"h264 1920x1080 30/1","audio":"opus","duration":60} |

## B1

| metrik | nilai |
|---|---|
| proyek | 9 klip · 60 dtk |
| putar · seconds | 15 |
| putar · fps_rendered | 30.3 |
| putar · frames_missed_pct | 2.4 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 6.3 |
| putar · frame_draw_p95_ms | 8.9 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 183x325 |
| seek → frame (p50 / p95 / max ms) | 24.2 / 90.6 / 90.6 (n=20) |
| ekspor · state | done |
| ekspor · wall_ms | 51900 |
| ekspor · mode | fast |
| ekspor · fetch_media_ms | 0 |
| ekspor · prepare_ms | 1166 |
| ekspor · decode_ms | 3253 |
| ekspor · composite_ms | 42992 |
| ekspor · encode_ms | 4127 |
| ekspor · mux_ms | 47 |
| ekspor · total_ms | 51625 |
| ekspor · realtime_factor | 1.16 |
| ekspor · encoder_queue_max | 5 |
| ekspor · output_size | 32466423 |
| ekspor · renderer_rss_start_mb | 879 |
| ekspor · renderer_rss_peak_mb | 1435 |
| ekspor · js_heap_peak_mb | 100 |
| ekspor · probe | {"video":"h264 1080x1920 30/1","audio":"opus","duration":60} |

## B2

| metrik | nilai |
|---|---|
| proyek | 9 klip · 34 dtk |
| putar · seconds | 15 |
| putar · fps_rendered | 30.5 |
| putar · frames_missed_pct | 8.7 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 10.3 |
| putar · frame_draw_p95_ms | 15.1 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 56.6 / 208.7 / 208.7 (n=20) |
| ekspor · state | done |
| ekspor · wall_ms | 21240 |
| ekspor · mode | fast |
| ekspor · fetch_media_ms | 0 |
| ekspor · prepare_ms | 870 |
| ekspor · decode_ms | 2417 |
| ekspor · composite_ms | 12521 |
| ekspor · encode_ms | 5122 |
| ekspor · mux_ms | 24 |
| ekspor · total_ms | 20983 |
| ekspor · realtime_factor | 1.62 |
| ekspor · encoder_queue_max | 5 |
| ekspor · output_size | 27154980 |
| ekspor · renderer_rss_start_mb | 1013 |
| ekspor · renderer_rss_peak_mb | 1403 |
| ekspor · js_heap_peak_mb | 97 |
| ekspor · probe | {"video":"h264 1920x1080 30/1","audio":"opus","duration":34} |

## B3

| metrik | nilai |
|---|---|
| proyek | 62 klip · 600 dtk |
| putar · seconds | 10 |
| putar · fps_rendered | 30.1 |
| putar · frames_missed_pct | 0 |
| putar · video_dropped_pct | 0 |
| putar · frame_draw_p50_ms | 6.2 |
| putar · frame_draw_p95_ms | 8 |
| putar · buffer_waits | 0 |
| putar · long_tasks | 0 |
| putar · preview_canvas | 579x326 |
| seek → frame (p50 / p95 / max ms) | 41.1 / 57.6 / 57.8 (n=30) |
| ekspor · range_s | 120 |
| ekspor · size | 95576317 |
| ekspor · seconds | 45.745 |
| ekspor · mode | fast |
| ekspor · prepare_ms | 5909 |
| ekspor · fetch_media_ms | 0 |
| ekspor · decode_ms | 6343 |
| ekspor · composite_ms | 32989 |
| ekspor · encode_ms | 400 |
| ekspor · mux_ms | 80 |
| ekspor · realtime_factor | 2.62 |
| ekspor · encoder_queue_max | 2 |
| ekspor · renderer_rss_start_mb | 770 |
| ekspor · renderer_rss_peak_mb | 2715 |
| ekspor · js_heap_peak_mb | 669 |

## B4

| metrik | nilai |
|---|---|
| cold_ready_ms | 1215 |
| cold_first_frame_ms | 159 |
| cold_seek_p95_ms | 144.8 |
| cold_media_on_device_ms | 1107 |
| warm_ready_ms | 892 |
| warm_first_frame_ms | 177 |
| warm_seek_p95_ms | 154.4 |
| project_matches | true |

## B5

| metrik | nilai |
|---|---|
| b0-1080p30-60s.mp4 (88 MB) | upload 3775 ms · salinan siap 22539.8 ms |
| b2-main1-1080p.mp4 (18 MB) | upload 504.6 ms · salinan siap 8803.7 ms |
| b1-clip4-1080x1920.mp4 (12 MB) | upload 1506 ms · salinan siap 11367.2 ms |
| b3-long-10m-1080p.mp4 (439 MB) | upload 7913.2 ms · salinan siap 126150.6 ms |
| latensi API saat antre (p50 / p95 ms) | 9.5 / 32.4 |
| job server | {"edit":{"done":15,"failed":0,"wait":{"n":15,"p50":4462,"p95":16900,"max":16900},"run":{"n":15,"p50":1998,"p95":100431,"max":100431},"limit":1,"running":0,"queued":0},"assets":{"done":20,"failed":0,"wait":{"n":21,"p50":8029,"p95":101160,"max":117330},"run":{"n":20,"p50":577,"p95":23958,"max":23958},"limit":1,"running":1,"queued":0},"proxy":{"done":0,"failed":0,"wait":null,"run":null,"limit":1,"running":0,"queued":0}} |
