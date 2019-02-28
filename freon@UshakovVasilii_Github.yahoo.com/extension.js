const St = imports.gi.St;
const Lang = imports.lang;
const PanelMenu = imports.ui.panelMenu;
const PopupMenu = imports.ui.popupMenu;
const Main = imports.ui.main;
const Util = imports.misc.util;
const Mainloop = imports.mainloop;
const Clutter = imports.gi.Clutter;
const Gio = imports.gi.Gio;
const GLib = imports.gi.GLib;

const Me = imports.misc.extensionUtils.getCurrentExtension();
const Convenience = Me.imports.convenience;
const UDisks2 = Me.imports.udisks2;
const AticonfigUtil = Me.imports.aticonfigUtil;
const NvidiaUtil = Me.imports.nvidiaUtil;
const HddtempUtil = Me.imports.hddtempUtil;
const SensorsUtil = Me.imports.sensorsUtil;
const smartctlUtil = Me.imports.smartctlUtil;
const BumblebeeNvidiaUtil = Me.imports.bumblebeeNvidiaUtil;
const FreonItem = Me.imports.freonItem;

const Gettext = imports.gettext.domain(Me.metadata['gettext-domain']);
const _ = Gettext.gettext;

function _makeLogFunction(prefix) {
    return msg => {
        // Grab the second line of a stack trace, i.e. caller of debug()
        let regex = /(?:(?:[^<.]+<\.)?([^@]+))?@(.+):(\d+):\d+/g;
        let trace = ((msg.stack) ? msg : new Error()).stack.split('\n')[1];
        let [m, func, file, line] = regex.exec(trace);
        file = GLib.path_get_basename(file);

        let hdr = [file, func, line].filter(k => (k)).join(':');

        GLib.log_structured(
            'freon',
            GLib.LogLevelFlags.LEVEL_MESSAGE,
            {
                MESSAGE: `[${prefix}] [${hdr}]: ${msg}`,
                SYSLOG_IDENTIFIER: 'org.gnome.shell.extensions.freon',
                CODE_FILE: file,
                CODE_FUNC: `${func}`,
                CODE_LINE: `${line}`
            }
        );
    }
}

var FreonMenuButton = new Lang.Class({
    Name: 'FreonMenuButton',
    Extends: PanelMenu.Button,

    _init: function(){
        this.parent(St.Align.START);

        this._settings = Convenience.getSettings();

        var _debugFunc = _makeLogFunction('DEBUG');
        this.debug = this._settings.get_boolean('debug') ? _debugFunc : () => {};

        this._settings.connect('changed::debug', () => {
            this.debug = this._settings.get_boolean('debug') ? _debugFunc : () => {};
        });

        this._sensorMenuItems = {};

        this._utils = {
            sensors: new SensorsUtil.SensorsUtil()
        };
        this._initDriveUtility();
        this._initGpuUtility();

        let temperatureIcon = Gio.icon_new_for_string(Me.path + '/icons/freon-temperature-symbolic.svg');
        this._sensorIcons = {
            'temperature' : temperatureIcon,
            'temperature-average' : temperatureIcon,
            'temperature-maximum' : temperatureIcon,
            'gpu-temperature' : Gio.icon_new_for_string(Me.path + '/icons/freon-gpu-temperature-symbolic.svg'),
            'drive-temperature' : Gio.icon_new_for_string('drive-harddisk-symbolic'),
            'voltage' : Gio.icon_new_for_string(Me.path + '/icons/freon-voltage-symbolic.svg'),
            'current' : Gio.icon_new_for_string(Me.path + '/icons/freon-voltage-symbolic.svg'),
            'fan' : Gio.icon_new_for_string(Me.path + '/icons/freon-fan-symbolic.svg')
        }

        this._menuLayout = new St.BoxLayout();
        this._hotLabels = {};
        this._hotIcons = {};
        let hotSensors = this._settings.get_strv('hot-sensors');
        let showIcon = this._settings.get_boolean('show-icon-on-panel');
        for (let s of hotSensors){
            this._createHotItem(s, showIcon);
        }

        if(hotSensors.length == 0){
            this._createInitialIcon();
        }

        this.actor.add_actor(this._menuLayout);

        this._settingChangedSignals = [];
        this._addSettingChangedSignal('update-time', Lang.bind(this, this._updateTimeChanged));
        this._addSettingChangedSignal('unit', Lang.bind(this, this._querySensors));
        this._addSettingChangedSignal('show-icon-on-panel', Lang.bind(this, this._showIconOnPanelChanged));
        this._addSettingChangedSignal('hot-sensors', Lang.bind(this, this._querySensors));
        this._addSettingChangedSignal('show-decimal-value', Lang.bind(this, this._querySensors));
        this._addSettingChangedSignal('show-fan-rpm', Lang.bind(this, this._querySensors));
        this._addSettingChangedSignal('show-voltage', Lang.bind(this, this._querySensors));
        this._addSettingChangedSignal('show-current', Lang.bind(this, this._querySensors));
        this._addSettingChangedSignal('drive-utility', Lang.bind(this, this._driveUtilityChanged));
        this._addSettingChangedSignal('gpu-utility', Lang.bind(this, this._gpuUtilityChanged));
        this._addSettingChangedSignal('position-in-panel', Lang.bind(this, this._positionInPanelChanged));
        this._addSettingChangedSignal('group-temperature', Lang.bind(this, this._querySensors))
        this._addSettingChangedSignal('group-voltage', Lang.bind(this, this._rerender))
        this._addSettingChangedSignal('group-current', Lang.bind(this, this._rerender))

        this.connect('destroy', Lang.bind(this, this._onDestroy));

        // don't postprone the first call by update-time.
        this._querySensors();

        this._addTimer();
        this._updateUITimeoutId = Mainloop.timeout_add(250, Lang.bind(this, function (){
            this._updateUI();
            // readd to update queue
            return true;
        }));
    },

    _createHotItem: function(s, showIcon, gicon){
        if(showIcon){
            let i = new St.Icon({ style_class: 'system-status-icon'});
            this._hotIcons[s] = i;
            if(gicon)
                i.gicon = gicon;
            this._menuLayout.add(i);
        }
        let l = new St.Label({
            text: '\u26a0',  // ⚠, warning
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._hotLabels[s] = l;
        this._menuLayout.add(l);
    },

    _createInitialIcon: function() {
        this._initialIcon = new St.Icon({ style_class: 'system-status-icon'});
        this._initialIcon.gicon = this._sensorIcons['gpu-temperature'];
        this._menuLayout.add(this._initialIcon);
    },

    _rerender : function(){
        this._needRerender = true;
        this._querySensors();
    },

    _positionInPanelChanged : function(){
        this.container.get_parent().remove_actor(this.container);

        // small HACK with private boxes :)
        let boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox
        };

        let p = this.positionInPanel;
        boxes[p].insert_child_at_index(this.container, p == 'right' ? 0 : -1)
    },

    _showIconOnPanelChanged : function(){
        if(this._settings.get_boolean('show-icon-on-panel')) {
            let index = 0;
            for(let k in this._hotLabels){
                let i = new St.Icon({ style_class: 'system-status-icon'});
                this._hotIcons[k] = i;
                i.gicon = this._sensorMenuItems[k].gicon;
                this._menuLayout.insert_child_at_index(i, index);
                index += 2;
            }
        } else {
            for(let k in this._hotIcons)
                this._hotIcons[k].destroy();
            this._hotIcons = {};
        }
    },

    _driveUtilityChanged : function(){
        this._destroyDriveUtility();
        this._initDriveUtility();
        this._querySensors();
    },

    _initDriveUtility : function(){
        switch(this._settings.get_string('drive-utility')){
            case 'hddtemp':
                this._utils.disks = new HddtempUtil.HddtempUtil();
                break;
            case 'udisks2':
                this._utils.disks = new UDisks2.UDisks2(Lang.bind(this, function() {
                    // this._updateDisplay(); we cannot change actor in background thread #74
                }));
                break;
            case 'smartctl':
                this._utils.disks = new smartctlUtil.smartctlUtil();
                break;
        }
    },

    _destroyDriveUtility : function(){
        if(this._utils.disks){
            this._utils.disks.destroy();
            delete this._utils.disks;
        }
    },

    _initGpuUtility : function(){
        switch(this._settings.get_string('gpu-utility')){
            case 'nvidia-settings':
                this._utils.gpu = new NvidiaUtil.NvidiaUtil();
                break;
            case 'aticonfig':
                this._utils.gpu = new AticonfigUtil.AticonfigUtil();
                break;
            case 'bumblebee-nvidia-smi':
                this._utils.gpu = new BumblebeeNvidiaUtil.BumblebeeNvidiaUtil();
                break;
        }
    },

    _destroyGpuUtility : function(){
        if(this._utils.gpu){
            this._utils.gpu.destroy();
            delete this._utils.gpu;
        }
    },

    _gpuUtilityChanged : function(){
        this._destroyGpuUtility();
        this._initGpuUtility();
        this._querySensors();
    },

    _updateTimeChanged : function(){
        Mainloop.source_remove(this._timeoutId);
        this._addTimer();
    },

    _addTimer : function(){
        this._timeoutId = Mainloop.timeout_add_seconds(this._settings.get_int('update-time'), Lang.bind(this, function (){
            this._querySensors();
            // readd to update queue
            return true;
        }));
    },

    _addSettingChangedSignal : function(key, callback){
        this._settingChangedSignals.push(this._settings.connect('changed::' + key, callback));
    },

    _onDestroy: function(){
        this._destroyDriveUtility();
        this._destroyGpuUtility();
        Mainloop.source_remove(this._timeoutId);
        Mainloop.source_remove(this._updateUITimeoutId);

        for (let signal of this._settingChangedSignals){
            this._settings.disconnect(signal);
        };
    },

    _querySensors: function(){
        for (let sensor of Object.values(this._utils)) {
            if (sensor.available) {
                sensor.execute(Lang.bind(this,function(){
                    // we cannot change actor in background thread #74
                }));
            }
        }
    },

    _updateUI: function(){
        let needUpdate = false;
        for (let sensor of Object.values(this._utils)) {
            if (sensor.available && sensor.updated) {
                this.debug(sensor + ' updated');
                sensor.updated = false;
                needUpdate = true;
            }
        }
        if(needUpdate) {
            this._updateDisplay(); // #74
            this.debug('update display');
        }
    },

    _fixNames: function(sensors){
        let names = [];
        for (let s of sensors){
            if(s.type == 'separator' ||
               s.type == 'temperature-group' ||
               s.type == 'temperature-average' ||
               s.type == 'temperature-maximum')
                continue;
            let name = s.label;
            let i = 1;
            while(names.indexOf(name) >= 0){
                name = s.label + '-' + i++;
            }
            if(name != s.label){
                s.displayName = s.label;
                s.label = name;
            }
            names.push(name);
        }
    },

    _updateDisplay: function(){
        let gpuTempInfo = this._utils.sensors.gpu;

        if (this._utils.gpu && this._utils.gpu.available)
            gpuTempInfo = gpuTempInfo.concat(this._utils.gpu.temp);

        let sensorsTempInfo = this._utils.sensors.temp;

        let fanInfo = [];
        if (this._settings.get_boolean('show-fan-rpm'))
            fanInfo = this._utils.sensors.rpm;

        let voltageInfo = [];
        if (this._settings.get_boolean('show-voltage'))
            voltageInfo = this._utils.sensors.volt;

        let currentInfo = [];
        if (this._settings.get_boolean('show-current'))
            currentInfo = this._utils.sensors.curr;

        let driveTempInfo = [];
        if(this._utils.disks && this._utils.disks.available) {
            driveTempInfo = this._utils.disks.temp;
        }

        sensorsTempInfo.sort(function(a,b) { return a.label.localeCompare(b.label) });
        driveTempInfo.sort(function(a,b) { return a.label.localeCompare(b.label) });
        fanInfo.sort(function(a,b) { return a.label.localeCompare(b.label) });
        voltageInfo.sort(function(a,b) { return a.label.localeCompare(b.label) });
        currentInfo.sort(function(a,b) { return a.label.localeCompare(b.label) });

        let tempInfo = gpuTempInfo.concat(sensorsTempInfo).concat(driveTempInfo);

        if (tempInfo.length > 0){
            let total = 0;
            let sum = 0;
            let max = 0;
            for (let i of tempInfo){
                if(i.temp !== null){
                    total++;
    	            sum += i.temp;
    	            if (i.temp > max)
    	                max = i.temp;
                }
            }

            let sensors = [];

            for (let i of gpuTempInfo){
                sensors.push({
                    type: 'gpu-temperature',
                    label: i.label,
                    value: this._formatTemp(i.temp),
                    displayName: i.displayName});
            }
            for (let i of sensorsTempInfo){
                sensors.push({type:'temperature', label: i.label, value:this._formatTemp(i.temp)});
            }
            for (let i of driveTempInfo){
                sensors.push({type:'drive-temperature', label: i.label, value:this._formatTemp(i.temp)});
            }

            if (tempInfo.length > 0){
                sensors.push({type : 'separator'});

                // Add average and maximum entries
                sensors.push({type: 'temperature-average',
                              key: '__average__',
                              label: _("Average"),
                              value: this._formatTemp(sum/total)});
                sensors.push({type: 'temperature-maximum',
                              key: '__max__',
                              label: _("Maximum"),
                              value: this._formatTemp(max)});

                if(fanInfo.length > 0 || voltageInfo.length > 0 || currentInfo.length > 0)
                    sensors.push({type : 'separator'});
            }

            if(sensorsTempInfo.length > 0 && this._settings.get_boolean('group-temperature')){
                sum = 0;
                for (let i of sensorsTempInfo){
                    sum += i.temp;
                }
                sensors.push({
                    type:'temperature-group',
                    label:'temperature-group',
                    value: this._formatTemp(sum / sensorsTempInfo.length)});
            }

            for (let fan of fanInfo){
                sensors.push({
                    type:'fan',
                    label:fan.label,
                    value:_("%drpm").format(fan.rpm)});
            }
            if (fanInfo.length > 0 && (voltageInfo.length > 0 || currentInfo.length > 0)){
                sensors.push({type : 'separator'});
            }
            for (let voltage of voltageInfo){
                sensors.push({
                    type : 'voltage',
                    label:voltage.label,
                    value:_("%s%.2fV").format(((voltage.volt >= 0) ? '+' : ''),
                    voltage.volt)});
            }
            if (voltageInfo.length > 0 && currentInfo.length > 0){
                sensors.push({type : 'separator'});
            }
            for (let current of currentInfo){
                sensors.push({
                    type : 'current',
                    label:current.label,
                    value:_("%.2fA").format(current.curr)});
            }

            this._fixNames(sensors);

            for (let k in this._hotLabels)
                this._hotLabels[k].set_text('\u26a0');  // ⚠, warning

            for (let s of sensors)
                if(s.type != 'separator') {
                    let l = this._hotLabels[s.key || s.label];
                    if(l)
                        l.set_text(s.value);
                }

            if(this._lastSensorsCount && this._lastSensorsCount==sensors.length){
                for (let s of sensors) {
                    if(s.type != 'separator') {
                        let item = this._sensorMenuItems[s.key || s.label];
                        if(item) {
                            if(s.type == 'temperature-group')
                                item.status.text = s.value;
                            else {
                                item.value = s.value;
                                if(s.displayName)
                                    item.display_name = s.displayName;
                            }
                        } else {
                            this._needRerender = true;
                        }
                    }
                }
            } else {
                this._needRerender = true;
            }

            if(this._needRerender){
                this._needRerender = false;
                this.debug('Render all MenuItems');
                this.menu.removeAll();
                this._appendMenuItems(sensors);
            }
        } else {
            this._sensorMenuItems = {};
            this.menu.removeAll();

            let item = new PopupMenu.PopupMenuItem(
                this._utils.sensors.available
                    ? _("Please run sensors-detect as root.")
                    : _("Please install lm_sensors.\nIf this doesn\'t help, click here to report with your sensors output!")
            );
            item.connect('activate',function() {
                Util.spawn(["xdg-open", "https://github.com/UshakovVasilii/gnome-shell-extension-freon/wiki/Dependency"]);
            });
            this.menu.addMenuItem(item);
            this._appendStaticMenuItems();
        }
    },

    _appendStaticMenuItems : function(){
        // separator
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        let wiki = new PopupMenu.PopupBaseMenuItem();
        wiki.actor.add(new St.Label({ text: _("Go to the Freon wiki") }), { expand: true, x_fill: false });
        wiki.connect('activate', function () {
                            Util.spawn(["xdg-open", "https://github.com/UshakovVasilii/gnome-shell-extension-freon/wiki"]);
        });
        this.menu.addMenuItem(wiki);

        let settings = new PopupMenu.PopupBaseMenuItem();
        settings.actor.add(new St.Label({ text: _("Sensor Settings") }), { expand: true, x_fill: false });
        settings.connect('activate', function () {
            Util.spawn(["gnome-shell-extension-prefs", Me.metadata.uuid]);
        });
        this.menu.addMenuItem(settings);
    },

    _appendMenuItems : function(sensors){
        this._lastSensorsCount = sensors.length;
        this._sensorMenuItems = {};
        let needGroupTemperature = this._settings.get_boolean('group-temperature');
        let needGroupVoltage = this._settings.get_boolean('group-voltage');
        let needGroupCurrent = this._settings.get_boolean('group-current');

        if(needGroupVoltage){
            let i = 0;
            for (let s of sensors)
                if(s.type == 'voltage')
                    i++;
            if(i < 2)
                needGroupVoltage = false;
        }

        if(needGroupCurrent){
            let i = 0;
            for (let s of sensors)
                if(s.type == 'current')
                    i++;
            if(i < 2)
                needGroupCurrent = false;
        }

        let temperatureGroup = null;
        let voltageGroup = null;
        let currentGroup = null;

        for (let s of sensors){
            if(s.type == 'separator'){
                 this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            } else if (s.type == 'temperature-group') {
                if(temperatureGroup) {
                    temperatureGroup.status.text = s.value;
                    this._sensorMenuItems['temperature-group'] = temperatureGroup;
                }
            } else {
                let key = s.key || s.label;
                let item = new FreonItem.FreonItem(this._sensorIcons[s.type], key, s.label, s.value, s.displayName || undefined);
                item.connect('activate', Lang.bind(this, function (self) {
                    let l = this._hotLabels[self.key];
                    let hotSensors = this._settings.get_strv('hot-sensors');
                    if(l){
                        hotSensors.splice(hotSensors.indexOf(self.key), 1);
                        delete this._hotLabels[self.key];
                        l.destroy(); // destroy is called after dict cleanup to prevert set_label on not exist actor
                        let i = this._hotIcons[self.key];
                        if(i){
                            i.destroy();
                            delete this._hotIcons[self.key];
                        }
                        self.main = false;
                    } else {
                        hotSensors.push(self.key);
                        if(Object.keys(this._hotLabels).length == 0){
                            this._initialIcon.destroy();
                            this._initialIcon = null;
                        }
                        let showIcon = this._settings.get_boolean('show-icon-on-panel');
                        this._createHotItem(self.key, showIcon, self.gicon);
                        self.main = true;
                    }

                    for(let i = hotSensors.length -1; i >= 0 ; i--){
                        let k = hotSensors[i];
                        if(!this._sensorMenuItems[k]){
                            hotSensors.splice(i, 1);
                            let ll = this._hotLabels[k]
                            delete this._hotLabels[k];
                            ll.destroy(); // destroy is called after dict cleanup to prevert set_label on not exist actor
                            if(this._hotIcons[k]){
                                this._hotIcons[k].destroy();
                                delete this._hotIcons[k];
                            }
                        }
                    }

                    if(Object.keys(this._hotLabels).length == 0)
                        this._createInitialIcon();

                    this._settings.set_strv('hot-sensors', hotSensors.filter(
                        function(item, pos) {
                            return hotSensors.indexOf(item) == pos;
                        }));
                }));
                if (this._hotLabels[key]) {
                    item.main = true;
                    if(this._hotIcons[key])
                        this._hotIcons[key].gicon = item.gicon;
                }
                this._sensorMenuItems[key] = item;

                if(needGroupTemperature && s.type == 'temperature') {
                    if(!temperatureGroup) {
                        temperatureGroup = new PopupMenu.PopupSubMenuMenuItem(_('Temperature Sensors'), true);
                        temperatureGroup.icon.gicon = this._sensorIcons['temperature'];
			if(!temperatureGroup.status) { // gnome 3.18 and hight
                            temperatureGroup.status = new St.Label({
				     style_class: 'popup-status-menu-item',
                                     y_expand: true,
                                     y_align: Clutter.ActorAlign.CENTER });
                            temperatureGroup.actor.insert_child_at_index(temperatureGroup.status, 4);
			}
                        this.menu.addMenuItem(temperatureGroup);
                    }
                    temperatureGroup.menu.addMenuItem(item);
                } else if(needGroupVoltage && s.type == 'voltage') {
                    if(!voltageGroup) {
                        voltageGroup = new PopupMenu.PopupSubMenuMenuItem(_('Voltage'), true);
                        voltageGroup.icon.gicon = this._sensorIcons['voltage'];
                        this.menu.addMenuItem(voltageGroup);
                    }
                    voltageGroup.menu.addMenuItem(item);
                } else if(needGroupCurrent && s.type == 'current') {
                    if(!currentGroup) {
                        currentGroup = new PopupMenu.PopupSubMenuMenuItem(_('Current'), true);
                        currentGroup.icon.gicon = this._sensorIcons['current'];
                        this.menu.addMenuItem(currentGroup);
                    }
                    currentGroup.menu.addMenuItem(item);
                } else {
                    this.menu.addMenuItem(item);
                }
            }
        }
        this._appendStaticMenuItems();
    },


    _toFahrenheit: function(c){
        return ((9/5)*c+32);
    },

    _formatTemp: function(value) {
        if(value === null)
            return 'N/A';
        if (this._settings.get_string('unit')=='fahrenheit'){
            value = this._toFahrenheit(value);
        }
        let format = '%.1f';
        if (!this._settings.get_boolean('show-decimal-value')){
            format = '%.0f';
        }
        format += '%s';
        return format.format(value, (this._settings.get_string('unit')=='fahrenheit') ? "\u00b0F" : "\u00b0C");
    },

    get positionInPanel(){
        return this._settings.get_string('position-in-panel');
    }
});

let freonMenu;

function init(extensionMeta) {
    Convenience.initTranslations();
}

function enable() {
    freonMenu = new FreonMenuButton();
    let positionInPanel = freonMenu.positionInPanel;
    Main.panel.addToStatusArea('freonMenu', freonMenu, positionInPanel == 'right' ? 0 : -1, positionInPanel);
}

function disable() {
    freonMenu.destroy();
    freonMenu = null;
}
