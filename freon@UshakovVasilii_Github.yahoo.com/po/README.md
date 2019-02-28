# Unreliable guide to localization in Freon

## The basics

Get the tools:

 - gettext: base internationalization library
 - intltool: helper tools that work on top of gettext

Know the different files:

 - `./<LANG>.po`: translation files (message catalogs)
 - `./freon.pot`: po template (all strings to translate)
 - `./POTFILES.in`: which files to search for strings to translate
 - `../locale/<LANG>/LC_MESSAGES/freon.mo`: compiled translations (what the application uses)

Where `<LANG>` refers to a valid language code.

## Updating a translation

First, update the po template:

```
$ intltool-update --pot && mv untitled.pot freon.pot
```

Then make the necessary adjustments to the desired translation files:

```
$ msgmerge -U <LANG>.po freon.pot
```

Recompile the translation file and place in the `../locale` directory:

```
$ msgfmt -cv <LANG>.po && mv messages.mo ../locale/<LANG>/LC_MESSAGES/freon.mo
```

Finally, reload GNOME Shell (or restart the session, if on Wayland).

<kbd>Alt</kbd>+<kbd>F2</kbd>+`r`+<kbd>ENTER</kbd>

## References

[Localising GNOME Applications (GNOME Wiki)](https://wiki.gnome.org/TranslationProject/LocalisationGuide)  
[Translate an extension (GNOME Wiki)](https://wiki.gnome.org/Projects/GnomeShell/Extensions/FAQ/CreatingExtensions)  

