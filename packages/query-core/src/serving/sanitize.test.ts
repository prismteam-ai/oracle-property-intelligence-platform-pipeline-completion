import { describe, expect, it } from 'vitest';

import { sanitizeLimitationText } from './service.js';

const SANITIZED =
  'A data source could not be fully processed during this run; the affected criterion is reported as unknown or unavailable.';

describe('sanitizeLimitationText', () => {
  it('collapses a raw DuckDB error that leaks a Windows build-machine path', () => {
    const leak =
      'Invalid Input Error: Error when sniffing file "E:\\temp\\oracle-gtfs-finalize-2s255h\\7e2371af8aebf6cc83761480a2bf6d092ff2155330f2a040d9347b8379213083".\nLINE 2: trips AS (SELECT * FROM read_csv_auto(?,';
    expect(sanitizeLimitationText(leak)).toBe(SANITIZED);
    expect(sanitizeLimitationText(leak)).not.toContain('E:\\temp');
    expect(sanitizeLimitationText(leak)).not.toContain('read_csv_auto');
  });

  it('collapses a raw Binder error that exposes internal SQL columns', () => {
    const leak =
      'Binder Error: Referenced column "theme" not found in FROM clause! Candidate bindings: "geometry", "categories", "emails", "phones", "websites" LINE 15: theme,';
    expect(sanitizeLimitationText(leak)).toBe(SANITIZED);
  });

  it('collapses a POSIX temp path leak', () => {
    expect(sanitizeLimitationText('failed reading /tmp/oracle-xyz/data.csv')).toBe(SANITIZED);
  });

  it('does not mistake a URL scheme (https://) for a drive path', () => {
    const provenance =
      'Backing ArcGIS source retained: https://services6.arcgis.com/evmyRZRrsopdeog7/ArcGIS/rest/services/AssessorsParcels/FeatureServer/0';
    expect(sanitizeLimitationText(provenance)).toBe(provenance);
  });

  it('keeps clean, honest limitation strings unchanged', () => {
    for (const clean of [
      'No supported or proxy public roof_age evidence is present in bounded release santa-clara-70ec78efee5b6c6b664fe8a3.',
      'Official capability page returned HTTP 403',
      'Redistribution rights are pending; all output remains prohibited_public.',
      'Bounded pilot acquisition executed 1 of 29 planned source items.',
      'Missing evidence must not be converted into a positive old-roof claim.',
    ]) {
      expect(sanitizeLimitationText(clean)).toBe(clean);
    }
  });
});
