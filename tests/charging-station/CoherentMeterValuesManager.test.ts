/**
 * @file Tests for CoherentMeterValuesManager session creation options.
 * @description Verifies that the `coherentRampUpDurationMs` template field
 *   reaches the created coherent session, and that its absence keeps the
 *   canonical default.
 */

import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import type { ChargingStation } from '../../src/charging-station/index.js'
import type { EvProfilesFile } from '../../src/charging-station/meter-values/types.js'

import { CoherentMeterValuesManager } from '../../src/charging-station/CoherentMeterValuesManager.js'
import { OCPPVersion } from '../../src/types/index.js'
import { Constants } from '../../src/utils/index.js'
import { standardCleanup } from '../helpers/TestLifecycleHelpers.js'
import { TEST_CHARGING_STATION_BASE_NAME, TEST_TRANSACTION_ID } from './ChargingStationTestConstants.js'
import { createMockChargingStation } from './helpers/StationHelpers.js'

const EV_PROFILES: EvProfilesFile = {
  profiles: [
    {
      batteryCapacityWh: 65000,
      chargingCurve: [{ powerFraction: 1, socPercent: 0 }],
      id: 'test-dc',
      initialSocPercentMax: 50,
      initialSocPercentMin: 15,
      maxPowerW: 112000,
      weight: 1,
    },
  ],
}

const createManager = (
  coherentRampUpDurationMs: number | undefined
): { manager: CoherentMeterValuesManager; station: ChargingStation } => {
  const { station } = createMockChargingStation({
    baseName: TEST_CHARGING_STATION_BASE_NAME,
    connectorsCount: 1,
    stationInfo: {
      coherentMeterValues: true,
      coherentRampUpDurationMs,
      ocppVersion: OCPPVersion.VERSION_16,
    },
    websocketPingInterval: Constants.DEFAULT_WS_PING_INTERVAL_SECONDS,
  })
  const manager = CoherentMeterValuesManager.getInstance(station)
  assert.ok(manager != null, 'manager should be created for a station with a hashId')
  // No evProfilesFile is configured, so inject the profile pool directly.
  ;(manager as unknown as { evProfiles?: EvProfilesFile }).evProfiles = EV_PROFILES
  return { manager, station }
}

await describe('CoherentMeterValuesManager', async () => {
  let station: ChargingStation | undefined

  afterEach(() => {
    if (station != null) {
      CoherentMeterValuesManager.deleteInstance(station)
      station = undefined
    }
    standardCleanup()
  })

  await it('should pass the template coherentRampUpDurationMs to the created session', () => {
    const created = createManager(240000)
    station = created.station
    const session = created.manager.createSession(TEST_TRANSACTION_ID, 1)
    assert.ok(session != null, 'session should be created')
    assert.strictEqual(session.rampUpDurationMs, 240000)
  })

  await it('should keep the default ramp-up duration when the template field is absent', () => {
    const created = createManager(undefined)
    station = created.station
    const session = created.manager.createSession(TEST_TRANSACTION_ID, 1)
    assert.ok(session != null, 'session should be created')
    assert.strictEqual(session.rampUpDurationMs, Constants.DEFAULT_COHERENT_RAMP_UP_DURATION_MS)
  })
})
