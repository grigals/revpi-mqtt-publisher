
# Usage
See the [demo](./demo.js) script for examples on how to use this API.

## Installation
Copy `RevPiInterface.js` and `schema.json` to your project, and merge the dependencies in `package.json` with your own, then run `npm install` to install the dependencies.

## Instantiation
Basic instantiation reads the attached modules from the RevPi's own config file, and automatically builds a list of available inputs, outputs, and memory locations available collectively known as "Tags".

```javascript
// Import the module
const RevPiInterface = require("./RevPiInterface");

// Instantiate
const revPi = new RevPiInterface();
```

or pass your own custom configuration:
```javascript
const RevPiInterface = require("./RevPiInterface");

// Load custom config file for RevPi interface
const fs = require("fs");
let newConf = JSON.parse(fs.readFileSync("./config.json.example"))

// Instantiate new RevPI Instance with custom config file
// This can be either a JSON string or an object
const revPi = new RevPiInterface(newConf);
```

## Reading Tags Once
```javascript
// Read one tag by passing the tag name
// Returns tag value
let tagValue = revPi.readTag("RevPiLED");

// Read all tags
// Returns {name1: value1, name2: value2, ...}
let allTags = revPi.readAll();
```

## Subscribe to Tag Changes
Tag changes are notified using `EventEmitters`. To receive tag change notifications, you must register a callback handler for the `change` event.
```javascript
// Register a callback for when tags change
revPi.on("change", (changedTags) => {
    // Do stuff with changed tags...
});

// Start the subscription
revPi.subscribe();
```

## Change Subscription Interval
By default, the library reports changes once a second. To change this to, for example 100 ms, run:
```javascript
revPi.setPollingInterval(100);
```

## End Tag Change Subscription
```javascript
revPi.unsubscribe();
```

## Write Tags
### Synchronously (Normally)
One tag:
```javascript
// Write desiredValue to tagName. Function responds with new tag value.
let newValue = revPi.writeTagSync(tagName, desiredValue);
```
Multiple tags:
```javascript
// Tags must be name:value pairs
let desiredValues = {"foo": 1, "bar": 2}
let newValues = revPi.writeTagsSync(desiredValues);
```

### Asynchronously
Asynchronous writes emit a `writeOne` event when completed. You must register a callback handler to respond to these events.
One tag:
```javascript
// Register a callback for when tag is written
revPi.on("writeOne", (newValue) => {
    // Do stuff with new value
});
// Write the new value
revPi.writeTag(tagName, desiredValue);
```
Multiple tags emit a `writeMany` event when completed:
```javascript
let desiredValues = {"foo": 1, "bar": 2}

// Register a callback for when each tag is written
revPi.on("writeOne", (newValue) => {
    // Do stuff with new value
});

// Register a callback for when all writes are complete
revPi.on("writeMany" () => {
    // Do stuff once writes are complete
})

// Write the new value
revPi.writeTags(desiredValues);
```

## Controls
The RevPis have built in controllable outputs, these can be set using built in functions.

### LEDs
All RevPi variants have three user controllable LEDs:
```javascript
// Import the module
const {RevPiInterface, REVPI_LED} = require("./RevPiInterface");

// Instantiate
let revPi = new RevPiInterface();

// Set LED 1 to green
revPi.setLED1(REVPI_LED.GREEN)
// Set LED 2 to red
revPi.setLED2(REVPI_LED.RED)
// Set LED 3 to orange
revPi.setLED3(REVPI_LED.ORANGE)

// Turn all LEDs off
revPi.setLED1(REVPI_LED.OFF)
revPi.setLED2(REVPI_LED.OFF)
revPi.setLED3(REVPI_LED.OFF)
```
### Relay
The Revpi Connect and Connect+ have a relay output that can be controlled by the user:
```javascript
// Import the module
const {RevPiInterface, REVPI_RELAY} = require("./RevPiInterface");

// Instantiate
let revPi = new RevPiInterface();

// Close the relay
revPi.setRelay(REVPI_RELAY.CLOSED);
// Open the relay
revPi.setRelay(REVPI_RELAY.OPEN);
```

### Watchdog
The Revpi Connect and Connect+ have a [hardware watchdog](https://revolution.kunbus.com/tutorials/uebersicht-revpi-connect/watchdog-connect/) that can be used to safeguard against system hangs. The watchdog timer can be reset to prevent the system rebooting using this library:
```javascript
revPi.kickWatchdog();
```

## Clean Up
```javascript
revPi.destroy();
```

# Events
* `change` is emitted when new tag values are read by subscription. Returns an object containing the changed tags.
* `writeOne` is emitted when writing a tag asynchronously. Returns the new tag value.
* `writeMany` is emitted when a batch of tag writes are complete. No return value.

## Set default tag values
To write default values (or to set memory type variables e.g. multipliers) to the revpi config file you can use:
```javascript
revPi.setTagDefault("tagName", 100);
```
However because the config file lives in /var/www, you must run your script as the www-data user using `sudo -u www-data node <your_script>.js`.

# Configuration
## Format
By default, this library reads the configuration set in PiCtory from `/etc/revpi/config.rsc`. However, for fieldbus gateways you need to specify the datatype of tags as these are not understood by the default config file.

The tag configuration must be provided as JSON in the form below (these will be validated against a schema by the library!):
```
{
    "<tag name>": {
        "value": <default/starting tag value>,
        "type": <type string>,
        "offset": <byte offset to read tag from>,
        "comment": <optional comment about the tag>
    },
    ...
}
```

## Type Strings
Type strings are not case sensitive.

Endianness refers to the byte order of the tag. Big = most significant byte first, Little = least significant byte first.

|Name|Endianness|String|
|--|--|--|
|Boolean||Boolean|
|Signed 8 bit integer||Int8|
|Unsigned 8 bit integer||uInt8|
|Signed 16 bit integer|Big|int16BE|
|Unsigned 16 bit integer|Big|uInt16BE|
|Signed 16 bit integer|Little|int16LE|
|Unsigned 16 bit integer|Little|uInt16LE|
|Signed 32 bit integer|Big|int32BE|
|Unsigned 32 bit integer|Big|uInt32BE|
|Signed 32 bit integer|Little|int32LE|
|Unsigned 32 bit integer|Little|uInt32LE|
|Float|Big|floatBE|
|Float|Litte|floatLE|
|Double|Big|doubleBE|
|Double|Litte|doubleLE|

## Byte offsets
This refers to where in the `/dev/piControl0` file to read/write a tag. These are defined in `/etc/revpi/config.rsc` but do not necessarily correspond to where your tags are. For instance, the fieldbus gateways write all data as bytes to the revpi. If a float is being transferred, you need to know where it starts to read the four bytes necessary to reconstruct it.

If you're writing to the fieldbus from something like a PLC, you can get the offsets from there and add them to the gateway offsets from `/etc/revpi/config.rsc` to get the byte offsets to read the tag from.

