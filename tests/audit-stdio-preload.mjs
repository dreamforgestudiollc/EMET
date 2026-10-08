/**
 * Installed with node --import before src/index.js so the stdio entry's
 * Mongo connections land in memory. The rate-limit check in index.js is what
 * the suite is loading; a real cluster is not.
 */
import { makeStore } from './memstore.js';
import { useTestClient } from '../src/mongo-connect.js';

useTestClient(makeStore().Client);
