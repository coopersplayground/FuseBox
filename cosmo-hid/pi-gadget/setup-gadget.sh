#!/bin/bash
# Cosmo HID - Raspberry Pi USB gadget setup (Muse Home production hub)
# =====================================================================
# Makes the Pi present itself to the user's PC, over its USB-C port,
# as a plain USB keyboard + ABSOLUTE mouse. No pairing, no drivers;
# works at login, UAC secure desktop, BIOS and BitLocker prompts.
#
# Run ON THE PI as root, once, at install time:
#   sudo bash setup-gadget.sh
# Then plug the Pi's USB-C port into the PC. Power the Pi from its
# GPIO header (5V/GND pins) or a PoE HAT - NOT from the target PC -
# so the hub stays alive when the PC sleeps or reboots.
#
# Device identity: deliberately plain (manufacturer/product below).
# A HID-only composite: no mass storage, no network function.
set -e

# 1. Enable the DWC2 controller in peripheral mode.
CFG=/boot/firmware/config.txt
[ -f "$CFG" ] || CFG=/boot/config.txt
grep -q '^dtoverlay=dwc2' "$CFG" || echo 'dtoverlay=dwc2,dr_mode=peripheral' >> "$CFG"
grep -q '^dwc2$' /etc/modules || echo 'dwc2' >> /etc/modules
grep -q '^libcomposite$' /etc/modules || echo 'libcomposite' >> /etc/modules

# 2. ConfigFS composite device: keyboard (hidg0) + absolute mouse (hidg1).
mkdir -p /sys/kernel/config/usb_gadget/cosmo-hid
cd /sys/kernel/config/usb_gadget/cosmo-hid
echo 0x1d6b > idVendor        # Linux Foundation (development default;
echo 0x0104 > idProduct       # replace with product VID/PID at ship)
echo 0x0100 > bcdDevice
echo 0x0200 > bcdUSB
mkdir -p strings/0x409
echo 'Muse Home' > strings/0x409/manufacturer
echo 'Cosmo Keyboard Mouse' > strings/0x409/product
echo 'cosmo-hid-001' > strings/0x409/serialnumber
mkdir -p configs/c.1/strings/0x409
echo 'Cosmo HID' > configs/c.1/strings/0x409/configuration
echo 250 > configs/c.1/MaxPower

# Keyboard: boot protocol, 8-byte reports.
mkdir -p functions/hid.usb0
echo 1 > functions/hid.usb0/protocol
echo 1 > functions/hid.usb0/subclass
echo 8 > functions/hid.usb0/report_length
printf '\x05\x01\x09\x06\xa1\x01\x05\x07\x19\xe0\x29\xe7\x15\x00\x25\x01\x75\x01\x95\x08\x81\x02\x95\x01\x75\x08\x81\x03\x95\x05\x75\x01\x05\x08\x19\x01\x29\x05\x91\x02\x95\x01\x75\x03\x91\x03\x95\x06\x75\x08\x15\x00\x25\x65\x05\x07\x19\x00\x29\x65\x81\x00\xc0' > functions/hid.usb0/report_desc

# Absolute mouse: buttons(1B) X int16 0..32767, Y int16 0..32767, wheel int8.
# Byte layout MUST match hid.py's mouse report: struct '<Bhhb'.
mkdir -p functions/hid.usb1
echo 2 > functions/hid.usb1/protocol
echo 1 > functions/hid.usb1/subclass
echo 6 > functions/hid.usb1/report_length
printf '\x05\x01\x09\x02\xa1\x01\x09\x01\xa1\x00\x05\x09\x19\x01\x29\x03\x15\x00\x25\x01\x95\x03\x75\x01\x81\x02\x95\x01\x75\x05\x81\x03\x05\x01\x09\x30\x09\x31\x16\x00\x00\x26\xff\x7f\x75\x10\x95\x02\x81\x02\x09\x38\x15\x81\x25\x7f\x75\x08\x95\x01\x81\x06\xc0\xc0' > functions/hid.usb1/report_desc

ln -s functions/hid.usb0 configs/c.1/
ln -s functions/hid.usb1 configs/c.1/
UDC=$(ls /sys/class/udc | head -1)
echo "$UDC" > UDC
echo "cosmo-hid gadget up on $UDC (keyboard=/dev/hidg0 mouse=/dev/hidg1)"
