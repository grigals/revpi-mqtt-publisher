const fs = require("fs");
const zlib = require("zlib");
const validate = require('jsonschema').validate;
const EventEmitter = require("events").EventEmitter;

class RevPiInterface extends (EventEmitter) {
    constructor(conf = null, interval = 1000) {
        super();
        // Load config from file
        this.configFile = "/var/www/pictory/projects/_config.rsc";
        this.revPiConf = JSON.parse(fs.readFileSync(this.configFile));

        // Create attributes for standard control bytes
        this.controlByteOffset = 0;
        this.getControlBytes();

        // Initiate tag list
        this.tags = {};
        // Set tag list from config
        this.parseConfig(conf);

        // Open the piControl0 file. This is where all data on the revpi lives
        // The config file above defines where to read/write in this file for data
        this.piControl = fs.openSync("/dev/piControl0", "r+");

        // Time between device updates
        this.pollTime = interval;

        // Handle for subscription loop
        this.pollInt;
    }

    /**
     * Get list of tags to interact with on RevPi from config file or specified custom config
     * @param {object} conf Either null for default config or config object matching schema
     */
    parseConfig(conf) {
        if (conf === null) {
            // Read PiCtory configuration file. This defines what we're running on and
            // what modules/gateways/intefaces are connected
            this.revPiConf.Devices.forEach(dev => {
                this.tags = {
                    ...this.tags,
                    ...this.parseRows(dev.inp, dev.offset),
                    ...this.parseRows(dev.out, dev.offset),
                    ...this.parseRows(dev.mem, dev.offset)
                }
            })
        } else {
            let newConf = conf;
            // Read config from passed JSON
            if (typeof (newConf) === "string") {
                try {
                    newConf = JSON.parse(newConf);
                } catch (e) {
                    console.error("Config is not a JSON string");
                }
            }
            // Validate against schema
            const schemaValidation = validate(newConf, JSON.parse(fs.readFileSync(__dirname + "/schema.json")));
            if (schemaValidation.valid) {
                this.tags = newConf;
            } else {
                throw new Error(`JSON does not match schema: ${schemaValidation.errors[0].message}`);
            }
        }
    }

    /**
     * Find the offset of the control bytes in the process file for easy access later
     */
    getControlBytes() {
        // Check each device
        this.revPiConf.Devices.forEach(dev => {
            // Control byte is an output
            Object.values(dev.out).forEach((output) => {
                switch (output[0]) {
                    case "RevPiLED":
                        this.controlByteOffset = this.parseRow(output, dev.offset).offset;
                        break;
                    // I might do something with these two later...
                    // case "RS485ErrorLimit1":
                    // case "RS485ErrorLimit2":
                    // this[output[0]] = this.parseRow(output, dev.offset);
                    // break;
                }
            })
        })
    }

    /**
     * Writes a bit to the control byte at the specified position
     * @param {int} offset The bit offset to write "value" to
     * @param {byte} mask The mask to apply to the byte write
     * @param {int or bool} value The value to write to the control byte
     */
    writeControlByte(offset, mask, value) {
        let buf = Buffer.alloc(1);
        fs.readSync(this.piControl, buf, 0, 1, this.controlByteOffset);
        buf[0] = (buf[0] & mask) | (value << offset);
        fs.writeSync(this.piControl, buf, 0, 1, this.controlByteOffset);
    }

    /**
     * Change the state of LED 1
     * @param {enum} state The target state for the LED
     */
    setLED1(state) {
        this.writeControlByte(0, ~(0x03), state);
    }

    /**
     * Change the state of LED 2
     * @param {enum} state The target state for the LED
     */
    setLED2(state) {
        this.writeControlByte(2, ~(0x03 << 2), state);
    }

    /**
     * Change the state of LED 3
     * @param {enum} state The target state for the LED
     */
    setLED3(state) {
        this.writeControlByte(4, ~(0x03 << 4), state);
    }

    /**
     * Change the state of the built in relay output
     * @param {enum} state The desired relay state
     */
    setRelay(state) {
        this.writeControlByte(6, ~(0x01 << 6), state);
    }

    /**
     * Toggles the watchdog bit to prevent the system rebooting, if enabled
     */
    kickWatchdog() {
        this.writeControlByte(7, ~(0x01 << 7), 0);
        setTimeout(() => {
            this.writeControlByte(7, ~(0x01 << 7), 1)
        }, 100);
    }

    /**
     * Parse tag objects from array definitions
     * @param {array} rows List of tags specifications to inspect
     * @param {int} devOffset Byte offset of this revpi device
     * @returns {object} Parsed tag object
     */
    parseRows(rows, devOffset = 0) {
        let obj = {};
        Object.values(rows).forEach((row) => {
            let parsedRow = this.parseRow(row, devOffset)
            if (parsedRow.type != undefined) {
                // Dont add undefined tags as can't read
                obj[row[0]] = parsedRow
            }
        });
        return obj
    }

    /**
     * Parse a tag object from an array definition
     * @param {object} row The tag specification to parse
     * @param {int} devOffset Byte offset of this revpi device. Applied as constant offset to all parsed tags
     * @returns {object} Parsed tag
     */
    parseRow(row, devOffset = 0) {
        // See https://revolution.kunbus.com/tutorials/was-ist-pictory-2/tabellarische-auflistung-aller-json-attribute-einer-rsc-datei-compact/
        // Row indices:
        // 0 Name
        // 1 Default value
        // 2 Bit length of the value
        // 3 Offset compared to device offset
        // 4 Is the value exported?
        // 5 Sort sequence (for display)
        // 6 Comment
        // 7 Contains the bit position for booleans

        let obj = {                                 // Tag name
            value: parseInt(row[1]),                    // Tag value
            type: this.typeFromLen(parseInt(row[2])),   // Tag length (datatype)
            offset: devOffset + parseInt(row[3]),       // Tag offset (where tag lives in /dev/piControl0)
            comment: row[6]                             // User comment for tag
        };

        if (row[7]) { // If a bit position is specified (boolean tag)
            // Read the byte offset by doing a floor divide by 8
            // Add the bit offset using modulo divide by 8, dividing by 10 and adding to the byte offset
            // Boolean offsets are of the form "m.n" where m is byte number and n is bit number
            obj.offset += ~~(row[7] / 8) + (parseInt(row[7]) % 8) / 10;
        }
        return obj;
    }

    /**
     * Makes an educated guess as to the variable type of the specified length from the config file
     * @param {integer} len The length of the variable in the config file
     * @returns A best guess of the variable type
     */
    typeFromLen(len) {
        // This makes assumptions about the default types in config.rsc as there
        // is no way to get the type from the file, only from context.
        switch (len) {
            case 1:
                return "boolean";
            case 8:
                return "UInt8";
            case 16:
                return "Int16LE";
            case 32:
                return "Int32LE";
        }
    }

    /**
     * Get byte length of variable type representation
     * @param {string} type A variable type
     * @returns {int} The byte length of a variable typ
     */
    lenFromType(type) {
        const lType = type.toLowerCase();
        if (lType === "boolean" || lType.search(/int8/g) > -1) {
            return 1
        } else if (lType.search(/int16/g) > -1) {
            return 2
        } else if (lType === "float" || lType.search(/int32/g) > -1) {
            return 4
        } else {
            console.err(`lenFromType: Unhandled type: ${type}`);
        }
    }

    /**
     * Read values of all tags
     * @returns Object containing tag name/values
     */
    readAll() {
        let resObj = {};
        Object.keys(this.tags).forEach((tagName) => {
            resObj[tagName] = this.readTag(tagName);
        });
        return resObj;
    }

    /**
     * Change the time between successive tag value reads
     * @param {int} pollTime The time between tag value reads
     */
    setPollingInterval(pollTime) {
        // Clear existing subscription
        this.unsubscribe();
        // Change the time interval
        this.pollTime = pollTime;
        // Restart the subscription
        this.subscribe();
    }

    /**
     * Start periodic subscription to changes in tag values
     */
    subscribe() {
        this.pollInt = setInterval(() => {
            let resObj = {};
            // Read all tags
            Object.keys(this.tags).forEach((tagName) => {
                // If value changed, add to output object
                if (this.readTag(tagName, true)) {
                    resObj[tagName] = this.tags[tagName].value
                }
            });
            // If any tags changed, emit change event
            // The subscriber needs to register a callback to get anything useful from this
            // e.g. revPi.on('change', (obj) => ...);
            if (Object.keys(resObj).length) {
                this.emit("change", resObj);
            }
        }, this.pollTime);
    }

    /**
     * Stop periodic subscription to changes in tag values
     */
    unsubscribe() {
        clearInterval(this.pollInt);
        this.pollInt = null;
    }

    /**
     * Read single tag
     * @param {Object} tag Tag object containing name, value, length, offset
     * @returns Boolean indicating whether tag changed value or no
     */
    readTag(tagName, reportChange = false) {
        const byteLen = this.lenFromType(this.tags[tagName].type);
        let buf = Buffer.alloc(byteLen);
        fs.readSync(this.piControl, buf, 0, byteLen, Math.floor(this.tags[tagName].offset));
        const oldVal = this.tags[tagName].value;
        this.tags[tagName].value = this.bufferToValue(buf, this.tags[tagName]);
        // Check if tag value changed
        return (reportChange ? this.tags[tagName].value !== oldVal : this.tags[tagName].value);
    }

    /**
     * Reads a value from the buffer according to tag.type
     * @param {buffer} buf Buffer containing tag value
     * @param {object} tag Tag object containing name, type, etc
     * @returns {various} The parsed value from the buffer according to tag.type
     */
    bufferToValue(buf, tag) {
        switch (tag.type.toLowerCase()) {
            case "boolean":
                const bit = (tag.offset * 10) - ((~~tag.offset) * 10);
                return ((buf[0] >> bit) & 0x01) == 1;
            case "uint8":
                return buf[0];
            case "int8":
                return buf[0].readInt8();
            case "int16be":
                return buf.readInt16BE();
            case "uint16be":
                return buf.readUInt16BE();
            case "int16le":
                return buf.readInt16LE();
            case "uint16le":
                return buf.readUInt16LE();
            case "int32be":
                return buf.readInt32BE();
            case "uint32be":
                return buf.readUInt32BE();
            case "int32le":
                return buf.readInt32LE();
            case "uint32le":
                return buf.readUInt32LE();
            case "floatbe":
                return buf.readFloatBE();
            case "floatle":
                return buf.readFloatLE();
            case "doublebe":
                return buf.readDoubleBE();
            case "doublele":
                return buf.readDoubleLE();
            default:
                console.error(`bufferToValue: Unhandled type ${tag.type}`);
        }
    }

    /**
     * Convert a given tag value to a buffer
     * @param {object} tag The tag object containing type, value, name etc
     * @returns {buffer} The tag value as a buffer
     */
    valueToBuffer(tag) {
        const buf = Buffer.alloc(this.lenFromType(tag.type));
        switch (tag.type.toLowerCase()) {
            case "boolean":
                break;
            case "uint8":
                buf.writeUInt8(tag.value);
                break;
            case "int8":
                buf.writeInt8(tag.value);
                break;
            case "int16be":
                buf.writeInt16BE(tag.value);
                break;
            case "uint16be":
                buf.writeUInt16BE(tag.value);
                break;
            case "int16le":
                buf.writeInt16LE(tag.value);
                break;
            case "uint16le":
                buf.writeUInt16LE(tag.value);
                break;
            case "int32be":
                buf.writeInt32BE(tag.value);
                break;
            case "uint32be":
                buf.writeUInt32BE(tag.value);
                break;
            case "int32le":
                buf.writeInt32LE(tag.value);
                break;
            case "uint32le":
                buf.writeUInt32LE(tag.value);
                break;
            case "floatbe":
                buf.writeFloatBE(tag.value);
                break;
            case "floatle":
                buf.writeFloatLE(tag.value);
                break;
            case "doublebe":
                buf.writeDoubleBE(tag.value);
                break;
            case "doublele":
                buf.writeDoubleLE(tag.value);
                break;
            default:
                console.error(`bufferToValue: Unhandled type ${tag.type}`);
        }
        return buf
    }

    /**
     * Write tag values to RevPi asynchronously
     * @param {object} tags Tag objects whose value is to be written to the RevPi
     */
    async writeTags(tags) {
        await Promise.all(Object.entries(tags).map((name, value) => {
            this.writeTag(name, value);
        }));
        this.emit("writeMany");
    }

    /**
     * Write a given value to the RevPi address specified by the tag name asynchronously
     * @param {string} name The name of the tag to write
     * @param {various} value The value of the tag to write
     */
    async writeTag(name, value) {
        const tag = this.tags[name];
        tag.value = value;
        // Special write case for booleans
        if (tag.type == "boolean") {
            this.writeBit(tag.offset, tag.value);
        } else {
            // Write tag asynchronously
            let buf = this.valueToBuffer(tag);
            fs.write(this.piControl, buf, 0, buf.length, ~~(tag.offset), () => {
                // The subscriber needs to register a callback to receive this write complete event
                this.emit("writeOne", value);
            });
        }
    }

    /**
     * Write a bit within a byte on the RevPi asynchronously
     * @param {float} offset M.N address of tag in RevPi where M = byte offset and N = bit offset
     * @param {various} value Value to write to the RevPi
     */
    writeBit(offset, value) {
        const buf = Buffer.alloc(1);
        // Get bit number to write
        const bit = (offset * 10) - ((~~offset) * 10);
        // Create Mask
        const mask = 0x01 << bit;
        // Read the byte
        fs.readSync(this.piControl, buf, 0, 1, ~~(offset));
        // Set the bit
        if (value) {
            buf[0] |= mask;
        } else {
            // Clear bit
            buf[0] &= ~mask;
        }
        fs.write(this.piControl, buf, 0, buf.length, ~~(offset), () => {
            // The subscriber needs to register a callback to receive this write complete event
            this.emit("writeOne", value);
        });
    }

    /**
     * Write tag values to the RevPi synchronously
     * @param {object} tags The tags to write to the RevPi
     * @returns {various} The value of the tags that were written
     */
    writeTagsSync(tags) {
        let newValues = {};
        Object.entries(tags).forEach((name, value) => {
            newValues[name] = this.writeTagSync(name, value);
        })
        return newValues;
    }

    /**
     * Write a value to the specified tag on the RevPi synchronously
     * @param {string} name The name of the tag to write
     * @param {various} value The value of the tag to write
     * @returns {various} The value that was written
     */
    writeTagSync(name, value) {
        const tag = this.tags[name];
        tag.value = value;
        let buf;
        if (tag.type == "boolean") {
            return this.writeBitSync(tag.offset, tag.value);
        } else {
            const buf = this.valueToBuffer(tag);
            fs.writeSync(this.piControl, buf, 0, buf.length, ~~(tag.offset))
            return value
        }
    }

    /**
     * Write a bit within a byte on the RevPi synchronously
     * @param {float} offset M.N address of tag in RevPi where M = byte offset and N = bit offset
     * @param {various} value Value to write to the RevPi
     * @returns {boolean} The value written to the RevPi
     */
    writeBitSync(offset, value) {
        const buf = Buffer.alloc(1);
        // Get bit number to write
        const bit = (offset * 10) - ((~~offset) * 10);
        // Create Mask
        const mask = 0x01 << bit;
        // Read the byte
        fs.readSync(this.piControl, buf, 0, 1, ~~(offset));
        // Set the bit
        if (value) {
            buf[0] |= mask;
        } else {
            // Clear bit
            buf[0] &= ~mask;
        }
        fs.writeSync(this.piControl, buf, 0, buf.length, ~~(offset));
        return value
    }

    /**
     * Set a default value for a tag and persist to RevPi config file
     * @param {string} name Name of the tag to set default value of
     * @param {any} value The default value of the tag
     */
    async setTagDefault(name, value) {

        // Firstly backup and compress the existing config file
        const gzip = zlib.createGzip();
        const r = fs.createReadStream(this.configFile);
        // Generate filename-friendly timestamp of the form YYYYMMDDHHmmSS
        const tStamp = (new Date()).toISOString().replace(/\.\d{3}Z/g, "").replace(/[-T:]/g, "");
        const w = fs.createWriteStream(`${this.configFile}_${tStamp}.gz`);
        r.pipe(gzip).pipe(w);

        // Then, set the new default value in the live config
        await Promise.all(this.revPiConf.Devices.map(async (dev, i) => {
            await Promise.all(['inp', 'out', 'mem'].map(async reg => {
                await Promise.all(Object.entries(dev[reg]).map(([key, tag]) => {
                    if (tag[0] === name) {
                        tag[1] = (value).toString();
                    }
                }))
            }))
        }))
        // Finally, write the new values to the config file
        fs.writeFileSync(this.configFile, JSON.stringify(this.revPiConf));
    }

    /**
     * Safely stops the RevPi instance
     * Clear subscriptions and closes the process image file
     */
    destroy() {
        this.unsubscribe();
        this.tags = null;
        fs.closeSync(this.piControl);
    }

};

// ENUM for LED states
const REVPI_LED = {
    OFF: 0x00,
    GREEN: 0x01,
    RED: 0x02,
    ORANGE: 0x03,
}

// ENUM for relay states
const REVPI_RELAY = {
    CLOSED: 0x00,
    OPEN: 0x01,
}

exports.RevPiInterface = RevPiInterface;
exports.REVPI_LED = REVPI_LED;
exports.REVPI_RELAY = REVPI_RELAY;
