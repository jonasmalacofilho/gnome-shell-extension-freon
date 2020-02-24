const GLib = imports.gi.GLib;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const CommandLineUtil = Me.imports.commandLineUtil;

var LiquidctlUtil = class extends CommandLineUtil.CommandLineUtil {

    constructor() {
        super();
        let path = GLib.find_program_in_path('liquidctl');
        this._argv = path ? [path, 'status', '--json'] : null;
    }

    get temp() {
        return this._parseLiquidctlOutput('temp');
    }

    get gpu() {
        return [];
    }

    get rpm() {
        return this._parseLiquidctlOutput('rpm');
    }

    get volt() {
        return this._parseLiquidctlOutput('volt');
    }

    _parseLiquidctlOutput(sensorType) {
        if(!this._output)
            return [];

        let sensorUnit = {'temp': '°C', 'rpm': 'rpm', 'volt': 'V'}[sensorType];

        let data = []
        try {
            data = JSON.parse(this._output.join(''));
        } catch (e) {
            global.log(e.toString());
            return [];
        }

        let sensors = [];
        for (let device of data) {
            let deviceName = device['_description'].replace(/NZXT|Corsair|( \(.+)/g, '');
            for (let key in device[sensorUnit]) {
                let feature = {
                    label: deviceName + ' ' + key,
                    [sensorType]: device[sensorUnit][key]
                };
                sensors.push(feature);
            }
        }
        return sensors;
    }
};
