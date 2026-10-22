import { common } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { scanBarcode, scanCore } from '@kit.ScanKit';

// HarmonyOS-specific: ScanKit (@kit.ScanKit) is not a pure OpenHarmony public
// API. The system scanning UI needs no camera permission in module.json5.
const SCAN_SYSCAP: string = 'SystemCapability.Multimedia.Scan.ScanBarcode';
const USER_CANCELED: number = 1000500002;

export function canScanPairingCode(): boolean {
  return canIUse(SCAN_SYSCAP);
}

// Returns the raw QR text, or '' when the user cancels the scanner.
export async function scanPairingCode(context: common.Context): Promise<string> {
  const options: scanBarcode.ScanOptions = {
    scanTypes: [scanCore.ScanType.QR_CODE],
    enableMultiMode: false,
    enableAlbum: true
  };
  try {
    const result = await scanBarcode.startScanForResult(context, options);
    return result.originalValue;
  } catch (error) {
    if ((error as BusinessError).code === USER_CANCELED) return '';
    throw new Error(`SCAN_FAILED_${(error as BusinessError).code ?? 'unknown'}`);
  }
}
