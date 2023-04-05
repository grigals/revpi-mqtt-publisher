// Modules
const mqtt = require("mqtt");
let fs = require("fs");
let log = require("./lib/helpers/log");
const { RevPiInterface } = require("./lib/RevPi-Interface");
const { exit } = require("process");
require('dotenv').config({ path: './config/.env' })

// Read in config
let appConfigPath = "./config/config.json";
let appConfig = null;
try {
    appConfig = JSON.parse(fs.readFileSync(appConfigPath).toString());
} catch (err) {
    log("APP: Cannot find config file in: " + appConfigPath);
    exit()
}

// Topics
const baseTopic = appConfig.MQTTConnection.namespace;
const baseTopicIncoming = appConfig.MQTTConnection.namespace + "/tags/in";
const baseTopicOutgoing = appConfig.MQTTConnection.namespace + "/tags/out";
const baseTopicState = baseTopic + "/STATE";
const baseTopicLogs = baseTopic + "/logs";

// -----------MQTT-----------
// Connect
let mqttConnected = false;
log("MQTT: Attempting to connect to server...")
const client = mqtt.connect(appConfig.MQTTConnection.address, {
    username: appConfig.MQTTConnection.username,
    password: appConfig.MQTTConnection.password,
    will: {
        topic: baseTopicState,
        payload: "OFFLINE",
        retain: true,
    },
    clientId: "RevPi_MQTT_Publisher_" + Math.random().toString(16),
    connectTimeout: 30 * 1000,
    reconnectPeriod: 10 * 1000
});

client.on("connect", function () {
    client.publish(baseTopicState, "ONLINE", { retain: false });
    mqttConnected = true;
    log("MQTT: Connected");
    client.subscribe(baseTopicIncoming + "/#", function (err) { });
});

client.on("reconnect", function () {
    client.publish(baseTopicState, "ONLINE", { retain: false });
    mqttConnected = true;
    log("MQTT: Reconnected");
    client.subscribe(baseTopicIncoming + "/#", function (err) { });
});

client.on("disconnect", function () {
    log("MQTT Disconnected");
    mqttConnected = false;
});

client.on("error", function (error) {
    log(error.toString());
    client.publish(baseTopicLogs, error.toString(), { retain: true });
    client.publish(baseTopicState, "OFFLINE", { retain: true });
    mqttConnected = false;
    process.exit()
});

client.on("message", function (topic, message) {
    // Handle incoming messages such as commands
    log(
        "MQTT: Incoming Message: Topic: " +
        topic.toString() +
        " Message: " +
        message.toString()
    );

    const tagName = topic.toString().split(baseTopicIncoming + "/")[1];
    const tagValue = message.toString();
    log("RevPi: Incoming Tag Write: '" + tagName + "' with value: " + tagValue);

    if (tagName === "RESTART_APP") {
        // Reboot app command
        client.publish(baseTopicState, "OFFLINE", { retain: true });
        process.exit()
    } else {
        // RevPi Incoming Tags
        try {
            // Try setting tag
            revPi.writeTagSync(tagName, tagValue);
            log("RevPi: Tag written");
        } catch (error) {
            log(
                "RevPi: Error writing tag: '" +
                tagName +
                "' with value: " +
                tagValue
            );
            client.publish(baseTopicLogs, error.toString(), { retain: false });
        }
    }
});


// -----------RevPi-----------
let revPi = new RevPiInterface(null, appConfig.RevPi.pollingIntervalInMs);

// Register a callback for when tags change
revPi.on("change", (changedTags) => {
    if (mqttConnected === true) {
        // If connected publish new vales to MQTT
        for (let changedTag in changedTags) {
            const topic = baseTopicOutgoing + "/" + changedTag;
            const value = changedTags[changedTag].toString();
            client.publish(topic, value, { qos: 1, retain: false });
        }
    }
});

// Publish RevPi Info
const info = {
    PiCtoryVersion: revPi.revPiConf.App.version,
    PiCtoryTimeStamp: revPi.revPiConf.App.saveTS,
    PiCtoryConfiguration: JSON.stringify(revPi.revPiConf, null, 4),
};
revPi.revPiConf.Devices.forEach((element) => {
    info[element.id] = element.GUID;
});

for (let item in info) {
    const topic = baseTopic + "/info/" + item;
    const value = info[item].toString();
    client.publish(topic, value, { qos: 1, retain: false });
}

// // Tag subscription
log("APP: Start Tag Subscription...");
// Poll on interval all RevPi Tags and publish to MQTT on change
revPi.subscribe();
