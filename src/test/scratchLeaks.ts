/**
 * Vitest setup file: a test file that ends with a registered child still running, or a registered handle still open
 * (src/test/scratchHandles.ts), has it stopped or closed here, and fails naming each child it left running. Not shipped.
 */
import { afterAll } from 'vitest'
import { settleAllScratch } from './scratchHandles'

afterAll(settleAllScratch)
