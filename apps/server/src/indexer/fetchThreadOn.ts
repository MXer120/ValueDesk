/** The production entry's first import, so that every client below it goes through the thread (fetchThread.ts). */
import { installFetchThread } from './fetchThread.js';

installFetchThread();
