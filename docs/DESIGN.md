# DESIGN.md --- Najja Creative Studio

## v2.0 --- Visual continuity with the existing Najja Editor

**Design status:** Existing-product continuity baseline; pixel-level
sign-off requires current application screenshots and source-token
inspection.

## 1. Design intent

The new Najja Creative Studio must look and feel like a mature evolution
of the existing Najja Editor---not a generic SaaS dashboard and not a
visual copy of CapCut.

The current Najja Editor is the source of truth for visual identity,
familiar control placement, terminology, and core workspace behavior.
The rebuild may improve clarity, spacing, responsiveness, accessibility,
and feedback, but should avoid unnecessary redesign.

**Primary rule:** preserve what users recognize; improve what slows them
down.

## 2. Visual parity rules

Before implementation, capture the current application at representative
states: - Home/project list. - Video editor with media bin, preview,
inspector, and timeline visible. - Video editor with a selected clip and
properties panel open. - Design editor with canvas, layers, and
properties panel visible. - Upload/processing, save, export, and error
states. - iPad layouts in portrait and landscape where supported.

Extract actual values from the running application or source: - Brand
colors and accent colors. - Background and panel colors. - Font family,
sizes, weights, and line heights. - Border, radius, shadow, and spacing
scale. - Icon family, stroke weight, and button dimensions. - Toolbar
heights, panel widths, and timeline proportions.

Do not invent replacement brand tokens when the existing implementation
can be measured. Store the extracted values in design tokens and
document any intentional changes.

## 3. Preserve existing editor composition

### 3.1 Video Studio

Keep the recognizable existing editing composition: - Top
application/editor toolbar with project actions and common controls. -
Media/tool area on the left. - Preview monitor in the central work
area. - Contextual properties/inspector area on the right. - Multitrack
timeline across the lower work area. - Familiar timeline controls, clip
selection behavior, and playback controls.

Improve: - Consistent alignment and spacing. - Clearer
selected/hover/drag states. - Better panel resizing and collapse
behavior. - Timeline readability at different zoom levels. - Visible
preview-quality and processing status. - Better touch hit targets and
gesture conflict handling on iPad.

Do not move core controls merely to make the screen look newer. Any
structural change requires a workflow comparison and user validation.

### 3.2 Design Studio

Keep the existing Najja Desain mental model: - Main document toolbar. -
Left-side creation tools and asset/template access. - Central
canvas/artboard. - Right-side properties and layer controls. - Existing
page navigation pattern where available.

Improve: - Selection handles and snapping guides. - Layer hierarchy and
selected-object clarity. - Text editing feedback. - Canvas zoom/pan
behavior. - Large-document responsiveness. - Touch and Pencil
interactions on iPad.

### 3.3 Home and project surfaces

Retain the current Najja identity and recognizable project navigation.
Keep project browsing efficient and compact. Do not turn the entire
application into oversized dashboard cards.

## 4. Design tokens

**Token extraction requirement:** the values below are semantic token
names, not assertions about current Najja colors. Map them to the exact
existing app values during the visual audit.

``` css
:root {
  --najja-app-bg: <extract-from-existing-app>;
  --najja-panel-bg: <extract-from-existing-app>;
  --najja-panel-raised: <extract-from-existing-app>;
  --najja-canvas-bg: <extract-from-existing-app>;
  --najja-text-primary: <extract-from-existing-app>;
  --najja-text-secondary: <extract-from-existing-app>;
  --najja-border: <extract-from-existing-app>;
  --najja-accent: <extract-from-existing-app>;
  --najja-success: <extract-from-existing-app>;
  --najja-warning: <extract-from-existing-app>;
  --najja-danger: <extract-from-existing-app>;
}
```

Rules: - Preserve the existing brand accent unless contrast or
accessibility requires adjustment. - Keep editing surfaces visually
quiet so media and canvas content remain prominent. - Use semantic
colors consistently. - Avoid decorative gradients, oversized cards, or
unnecessary animation if they do not exist in the current product. - Use
tabular numerals for timecodes, durations, and numeric inspector
fields. - Maintain visible keyboard focus and adequate contrast.

## 5. Layout behavior

### Desktop

-   Preserve current panel relationships and editing density.
-   Support resizable and collapsible panels.
-   Keep preview and timeline as primary work surfaces.
-   Avoid unnecessary full-page scrolling inside editor workspaces.
-   Persist user panel preferences per workspace where practical.

### iPad

-   Support landscape as the primary full-editing layout.
-   Portrait may use a compact/rearranged layout for review and lighter
    edits.
-   Use touch-sized controls without changing the visual language.
-   Support pinch zoom, pan, tap selection, and long-press/context
    actions where appropriate.
-   Prevent browser gestures from conflicting with canvas/timeline
    gestures.
-   Avoid presenting desktop hover-only affordances as the only way to
    discover controls.

## 6. Interaction and motion

-   Pointer/touch feedback should be immediate.
-   Dragging should use lightweight transient visual state.
-   Do not animate every panel or property update.
-   Respect reduced-motion settings.
-   Show progress locally for each asset/job; do not block the entire
    editor for one background task.
-   Keyboard shortcuts should remain discoverable and consistent.
-   Provide non-drag alternatives for important actions.

## 7. State design

Every workspace must define: - Initial/loading state. - Empty state. -
Selected state. - Hover/focus state. - Processing state. -
Saved/saving/unsaved state. - Offline state. - Error and retry state. -
Permission-denied state. - Export-complete state.

The save indicator must distinguish local persistence from server
acknowledgement.

## 8. Shared components

Reuse and standardize components without forcing identical layouts: -
EditorTopBar - WorkspacePanel - MediaBin - PreviewMonitor -
TimelineRuler - TimelineTrack - TimelineClip - PlaybackControls -
InspectorPanel - LayerPanel - CanvasViewport - SelectionHandles -
SnapGuide - PageNavigator - SaveStateIndicator - JobStatus -
UploadProgress - ExportDialog - ErrorWithRetry - ProductFidelityReview

## 9. Accessibility

-   Keyboard navigation and visible focus.
-   Semantic labels for icon-only controls.
-   Tooltips for unfamiliar controls.
-   Color is never the only status indicator.
-   Respect reduced motion.
-   Accessible alternatives for drag-and-drop.
-   Touch target sizing suitable for iPad.

## 10. Visual acceptance checklist

-   [ ] Current Najja Editor screenshots have been captured and
    reviewed.
-   [ ] Main workspace composition remains recognizable.
-   [ ] Brand colors, typography, iconography, and spacing are extracted
    from the current app.
-   [ ] Video toolbar, media area, preview, inspector, and timeline
    preserve familiar relationships.
-   [ ] Design canvas, tool panel, inspector, and layers preserve
    familiar relationships.
-   [ ] iPad landscape and portrait behavior is documented.
-   [ ] Loading, saving, processing, offline, and error states are
    designed.
-   [ ] No unrequested generic dashboard redesign has been introduced.
-   [ ] Existing users can perform familiar tasks without relearning the
    application.
