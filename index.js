/*
 * Copyright for portions of usbserial are held by Andreas Gal (2017) as part
 * of pl2303. All other copyright for pl2303 are held by Tidepool Project (2018).
 *
 * Prolific PL2303 user-space USB driver for Node.js
 *
 * SPDX-License-Identifier: MIT
 */

import assert from 'assert';

const SupportedBaudrates = [
  75, 150, 300, 600, 1200, 1800, 2400, 3600,
  4800, 7200, 9600, 14400, 19200, 28800, 38400,
  57600, 115200, 230400, 460800, 614400,
  921600, 1228800, 2457600, 3000000, 6000000,
];

async function vendorRead(device, value, index) {
  const buffer = await device.controlTransferIn({
    requestType: 'vendor',
    recipient: 'device',
    request: 0x01,
	value,
	index,
  }, 1);

  return buffer[0];
}

async function vendorWrite(device, value, index) {
  await device.controlTransferOut({
    requestType: 'class',
    recipient: 'device',
    request: 0x01,
    value,
    index,
  });
}

async function setBaudrate(device, baud) {
  assert(baud <= 115200);
  // find the nearest supported bitrate
  const list = SupportedBaudrates.slice().sort((a, b) => Math.abs(a - baud) - Math.abs(b - baud));
  const newBaud = list[0];
  await device.controlTransferIn({
    requestType: 'class',
    recipient: 'interface',
    request: 0x21,
	value: 0,
	index: 0,
  }, 7);

  console.log('Setting baud rate to', newBaud);

  const data = new ArrayBuffer(7);
  const parameters = new DataView(data);
  parameters.setInt32(0, newBaud, true);
  parameters.setUint8(4, 0); // 1 stop bit
  parameters.setUint8(5, 0); // no parity
  parameters.setUint8(6, 8); // 8 bit characters
  await device.controlTransferOut({
    requestType: 'class',
    recipient: 'interface',
    request: 0x20,
	value: 0,
	index: 0,
  }, parameters);

  await vendorWrite(device, 0x0, 0x0); // no flow control
  await vendorWrite(device, 8, 0); // reset upstream data pipes
  await vendorWrite(device, 9, 0);
}

export default class UsbSerial extends EventTarget {
  constructor(device, opts) {
    super();
    const bitrate = opts.baudRate || 9600;
    this.device = device;
    assert(this.device.deviceClass !== 0x02);

    (async () => {
      await this.device.open();
      assert(this.device.configuration.interfaces.length === 1);

      [this.iface] = this.device.configuration.interfaces;
      console.log('Claiming interface', this.iface.interfaceNumber);
      await this.device.claimInterface(this.iface.interfaceNumber);

      await vendorRead(this.device, 0x8484, 0);
      await vendorWrite(this.device, 0x0404, 0);
      await vendorRead(this.device, 0x8484, 0);
      await vendorRead(this.device, 0x8383, 0);
      await vendorRead(this.device, 0x8484, 0);
      await vendorWrite(this.device, 0x0404, 1);
      await vendorRead(this.device, 0x8484, 0);
      await vendorRead(this.device, 0x8383, 0);
      await vendorWrite(this.device, 0, 1);
      await vendorWrite(this.device, 1, 0);
      await vendorWrite(this.device, 2, 0x44);
      await setBaudrate(this.device, bitrate);

      this.isClosing = false;
      this.readLoop();
      this.dispatchEvent(new Event('ready'));
    })().catch((error) => {
      console.log('Error during PL2303 setup:', error);
      this.dispatchEvent(new CustomEvent('error', {
        detail: error,
      }));
    });
  }

  async readLoop() {
    let result;

    try {
      result = await this.device.transferIn(3, 64);
    } catch (error) {
      if (error.message.indexOf('LIBUSB_TRANSFER_NO_DEVICE')) {
        console.log('Device disconnected');
      } else {
        console.log('Error reading data:', error);
      }
    }

    if (result && result.data && result.data.byteLength) {
      console.log(`Received ${result.data.byteLength} byte(s).`);
      const uint8buffer = new Uint8Array(result.data.buffer);
      this.dispatchEvent(new CustomEvent('data', {
        detail: uint8buffer.slice(0),
      }));
    }

    if (!this.isClosing && this.device.opened) {
      this.readLoop();
    }
  }

  close(cb) {
    this.isClosing = true;
    setTimeout(async () => {
      try {
        await this.device.releaseInterface(0);
        await this.device.close();
      } catch (err) {
        console.log('Error while closing:', err);
      }
      return cb();
    }, 2000);
  }

  write(data, cb) {
    this.device.transferOut(2, data).then(() => {
      cb();
    }, (err) => cb(err, null));
  }
}
