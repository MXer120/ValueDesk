/**
 * The drag types this app sets for the knowledge folders - in a module of their
 * own, so a drag source (the News widget) does not load the folders' code
 * (quick.ts), which loads only while Knowledge is on (access.ts).
 */
export const DRAG_ITEM = 'application/x-vd-folder-item';
export const DRAG_NEWS = 'application/x-vd-news';
