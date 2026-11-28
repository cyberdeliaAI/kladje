//! Adds Markdown commands to WebView2's default context menu.

use super::{command_script, EditorContext, Submenu, SUBMENUS, TAKE_CONTEXT};
use std::{cell::Cell, rc::Rc};
use tauri::{AppHandle, Manager, WebviewWindow};
use webview2_com::{
    ContextMenuRequestedEventHandler, CustomItemSelectedEventHandler,
    ExecuteScriptCompletedHandler,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2, ICoreWebView2ContextMenuItem, ICoreWebView2ContextMenuItemCollection,
        ICoreWebView2ContextMenuRequestedEventArgs, ICoreWebView2Deferral,
        ICoreWebView2Environment, ICoreWebView2Environment9, ICoreWebView2_11,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR,
        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
    },
};
use windows_core::{w, Interface, Result, BOOL, HSTRING};

struct CommandTarget {
    app: AppHandle,
    label: String,
    menu_id: Cell<Option<u64>>,
}

struct NativeMenu {
    separator: ICoreWebView2ContextMenuItem,
    submenus: Vec<(&'static Submenu, ICoreWebView2ContextMenuItem)>,
    table_commands: Vec<(&'static str, ICoreWebView2ContextMenuItem)>,
}

impl NativeMenu {
    unsafe fn separator(env: &ICoreWebView2Environment9) -> Result<ICoreWebView2ContextMenuItem> {
        env.CreateContextMenuItem(w!(""), None, COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SEPARATOR)
    }

    // WebView2 allocates command IDs for created items. Keep a single set of
    // items and handlers per webview, even when the user opens the menu often.
    unsafe fn new(env: &ICoreWebView2Environment9, target: &Rc<CommandTarget>) -> Result<Self> {
        let separator = Self::separator(env)?;
        let mut submenus = Vec::new();
        let mut table_commands = Vec::new();
        for definition in SUBMENUS {
            let submenu = env.CreateContextMenuItem(
                &HSTRING::from(definition.title),
                None,
                COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_SUBMENU,
            )?;
            let children = submenu.Children()?;
            let mut index = 0;
            for group in definition.groups {
                if index != 0 {
                    children.InsertValueAtIndex(index, &Self::separator(env)?)?;
                    index += 1;
                }
                for &(command, title) in *group {
                    let item = env.CreateContextMenuItem(
                        &HSTRING::from(title),
                        None,
                        COREWEBVIEW2_CONTEXT_MENU_ITEM_KIND_COMMAND,
                    )?;
                    let target = Rc::clone(target);
                    let table_only = definition.table_only;
                    let handler = CustomItemSelectedEventHandler::create(Box::new(move |_, _| {
                        if let Some(id) = target.menu_id.take() {
                            if let Some(window) = target.app.get_webview_window(&target.label) {
                                let _ = window.eval(command_script(id, command, table_only));
                            }
                        }
                        Ok(())
                    }));
                    item.add_CustomItemSelected(&handler, &mut 0)?;
                    children.InsertValueAtIndex(index, &item)?;
                    index += 1;
                    if table_only {
                        table_commands.push((command, item));
                    }
                }
            }
            submenus.push((definition, submenu));
        }
        Ok(Self {
            separator,
            submenus,
            table_commands,
        })
    }

    unsafe fn append(
        &self,
        items: &ICoreWebView2ContextMenuItemCollection,
        context: &EditorContext,
    ) -> Result<()> {
        if let Some(enabled) = &context.table_commands {
            for (command, item) in &self.table_commands {
                item.SetIsEnabled(enabled.iter().any(|entry| entry == command))?;
            }
        }
        let mut index = 0;
        items.Count(&mut index)?;
        if index != 0 {
            items.InsertValueAtIndex(index, &self.separator)?;
            index += 1;
        }
        for (definition, submenu) in &self.submenus {
            if !definition.table_only || context.table_commands.is_some() {
                items.InsertValueAtIndex(index, submenu)?;
                index += 1;
            }
        }
        Ok(())
    }
}

struct MenuDeferral(ICoreWebView2Deferral);

impl Drop for MenuDeferral {
    fn drop(&mut self) {
        // WebView2 must be allowed to show its menu even if the script or
        // custom items fail, including when ExecuteScript fails to enqueue.
        let _ = unsafe { self.0.Complete() };
    }
}

unsafe fn request_menu(
    core: &ICoreWebView2,
    args: ICoreWebView2ContextMenuRequestedEventArgs,
    menu: Rc<NativeMenu>,
    target: Rc<CommandTarget>,
) -> Result<()> {
    let mut editable = BOOL::default();
    args.ContextMenuTarget()?.IsEditable(&mut editable)?;
    if !editable.as_bool() {
        return Ok(());
    }
    let deferral = MenuDeferral(args.GetDeferral()?);
    let completed = ExecuteScriptCompletedHandler::create(Box::new(move |status, result| {
        let _deferral = deferral;
        status?;
        // ExecuteScript returns JSON for the bridge's JSON string or null.
        if let Ok(Some(context)) = serde_json::from_str::<Option<String>>(&result) {
            if let Ok(context) = serde_json::from_str::<EditorContext>(&context) {
                unsafe { menu.append(&args.MenuItems()?, &context)? };
                target.menu_id.set(Some(context.id));
            }
        }
        Ok(())
    }));
    core.ExecuteScript(&HSTRING::from(TAKE_CONTEXT), &completed)
}

unsafe fn register(
    core: ICoreWebView2,
    env: ICoreWebView2Environment,
    target: Rc<CommandTarget>,
) -> Result<()> {
    let view: ICoreWebView2_11 = core.cast()?;
    let menu = Rc::new(NativeMenu::new(&env.cast()?, &target)?);
    let handler = ContextMenuRequestedEventHandler::create(Box::new(move |core, args| {
        target.menu_id.set(None);
        if let (Some(core), Some(args)) = (core, args) {
            let _ = unsafe { request_menu(&core, args, Rc::clone(&menu), Rc::clone(&target)) };
        }
        // Leave Handled at its default so WebView2 supplies the UI and runs
        // its own commands. Only Kladje's appended items have custom handlers.
        Ok(())
    }));
    view.add_ContextMenuRequested(&handler, &mut 0)
}

pub fn install(window: &WebviewWindow) -> tauri::Result<()> {
    let app = window.app_handle().clone();
    let label = window.label().to_owned();
    window.with_webview(move |platform| {
        let target = Rc::new(CommandTarget {
            app,
            label,
            menu_id: Cell::new(None),
        });
        // with_webview calls this on the owning UI thread. Older runtimes
        // retain their standard menu if the context-menu interfaces are absent.
        let _ = unsafe {
            platform
                .controller()
                .CoreWebView2()
                .and_then(|core| register(core, platform.environment(), target))
        };
    })
}
