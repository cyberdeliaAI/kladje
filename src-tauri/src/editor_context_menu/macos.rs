//! Adds Markdown commands to WebKit's proposed native menu.

use block2::{Block, RcBlock};
use objc2::{
    define_class, ffi, msg_send,
    rc::{Retained, Weak},
    runtime::{AnyObject, Bool, NSObject, NSObjectProtocol, ProtocolObject, Sel},
    sel, DefinedClass, MainThreadOnly,
};
use objc2_app_kit::{NSMenu, NSMenuItem};
use objc2_foundation::{ns_string, NSError, NSString};
use objc2_web_kit::{WKUIDelegate, WKWebView};
use std::ptr;

use super::{command_script, EditorContext, Submenu, SUBMENUS, TAKE_CONTEXT};

struct DelegateState {
    original: Option<Retained<ProtocolObject<dyn WKUIDelegate>>>,
    view: Weak<WKWebView>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = DelegateState]
    struct KladjeEditorContextDelegate;

    unsafe impl NSObjectProtocol for KladjeEditorContextDelegate {}
    unsafe impl WKUIDelegate for KladjeEditorContextDelegate {}

    impl KladjeEditorContextDelegate {
        #[unsafe(method(respondsToSelector:))]
        fn responds(&self, selector: Sel) -> Bool {
            let inherited: Bool = unsafe { msg_send![super(self), respondsToSelector: selector] };
            (inherited.as_bool() || self.ivars().original.as_ref()
                .is_some_and(|delegate| delegate.respondsToSelector(selector))).into()
        }

        #[unsafe(method(forwardingTargetForSelector:))]
        fn forwarding_target(&self, selector: Sel) -> *const AnyObject {
            if let Some(delegate) = self.ivars().original.as_ref()
                .filter(|delegate| delegate.respondsToSelector(selector))
            {
                return ptr::from_ref::<AnyObject>((**delegate).as_ref());
            }
            unsafe { msg_send![super(self), forwardingTargetForSelector: selector] }
        }

        // WebKit provides this delegate hook on macOS 10.14 and later. It
        // supplies the complete editable-text menu with its original targets.
        #[unsafe(method(_webView:getContextMenuFromProposedMenu:forElement:userInfo:completionHandler:))]
        fn proposed_menu(
            &self,
            view: &WKWebView,
            menu: *mut NSMenu,
            _element: *mut AnyObject,
            _user_info: *mut AnyObject,
            completion: &Block<dyn Fn(*mut NSMenu)>,
        ) {
            // WebKit calls on the main thread and owns the non-null arguments.
            let (Some(menu), Some(target)) = (unsafe {
                (Retained::retain(menu), Retained::retain(ptr::from_ref(self).cast_mut()))
            }) else {
                completion.call((menu,));
                return;
            };
            let completion = completion.copy();
            let callback = RcBlock::new(move |result: *mut AnyObject, error: *mut NSError| {
                if error.is_null() {
                    if let Some(context) = unsafe { result.as_ref() }
                        .and_then(|value| value.downcast_ref::<NSString>())
                        .and_then(|value| serde_json::from_str::<EditorContext>(&value.to_string()).ok())
                    {
                        target.append_editor_menu(&menu, context);
                    }
                }
                completion.call((Retained::as_ptr(&menu).cast_mut(),));
            });
            unsafe {
                view.evaluateJavaScript_completionHandler(
                    &NSString::from_str(TAKE_CONTEXT),
                    Some(&callback),
                );
            }
        }

        #[unsafe(method(kladjeChooseEditorCommand:))]
        fn choose(&self, sender: &NSMenuItem) {
            let Some(view) = self.ivars().view.load() else { return };
            if let Some(script) = sender.representedObject()
                .and_then(|payload| payload.downcast::<NSString>().ok())
            {
                unsafe { view.evaluateJavaScript_completionHandler(&script, None) };
            }
        }
    }
);

impl KladjeEditorContextDelegate {
    fn append_editor_menu(&self, menu: &NSMenu, context: EditorContext) {
        if menu.numberOfItems() > 0 {
            menu.addItem(&NSMenuItem::separatorItem(self.mtm()));
        }
        for submenu in SUBMENUS {
            if !submenu.table_only || context.table_commands.is_some() {
                menu.addItem(&self.submenu(submenu, &context));
            }
        }
    }

    fn submenu(&self, definition: &Submenu, context: &EditorContext) -> Retained<NSMenuItem> {
        let mtm = self.mtm();
        let title = NSString::from_str(definition.title);
        let submenu = NSMenu::initWithTitle(mtm.alloc(), &title);
        submenu.setAutoenablesItems(false);
        for (index, group) in definition.groups.iter().enumerate() {
            if index != 0 {
                submenu.addItem(&NSMenuItem::separatorItem(mtm));
            }
            for &(command, title) in *group {
                let script =
                    NSString::from_str(&command_script(context.id, command, definition.table_only));
                let item = unsafe {
                    let item = NSMenuItem::initWithTitle_action_keyEquivalent(
                        mtm.alloc(),
                        &NSString::from_str(title),
                        Some(sel!(kladjeChooseEditorCommand:)),
                        ns_string!(""),
                    );
                    item.setTarget(Some(self.as_ref()));
                    item.setRepresentedObject(Some(&script));
                    item
                };
                item.setEnabled(
                    !definition.table_only
                        || context
                            .table_commands
                            .as_ref()
                            .is_some_and(|commands| commands.iter().any(|op| op == command)),
                );
                submenu.addItem(&item);
            }
        }
        let item = unsafe {
            NSMenuItem::initWithTitle_action_keyEquivalent(
                mtm.alloc(),
                &title,
                None,
                ns_string!(""),
            )
        };
        item.setSubmenu(Some(&submenu));
        item
    }
}

pub fn install(view: &WKWebView) {
    let original = unsafe { view.UIDelegate() };
    // If another delegate already customizes context menus, let it keep
    // control. The remaining Wry delegate methods are forwarded unchanged.
    if original.as_ref().is_some_and(|delegate| {
        delegate.respondsToSelector(
            sel!(_webView:getContextMenuFromProposedMenu:forElement:userInfo:completionHandler:),
        ) || delegate.respondsToSelector(sel!(_webView:contextMenu:forElement:userInfo:))
            || delegate.respondsToSelector(sel!(_webView:contextMenu:forElement:))
    }) {
        return;
    }
    let delegate = view
        .mtm()
        .alloc::<KladjeEditorContextDelegate>()
        .set_ivars(DelegateState {
            original,
            view: Weak::new(view),
        });
    let delegate: Retained<KladjeEditorContextDelegate> =
        unsafe { msg_send![super(delegate), init] };
    // WKWebView's delegate property is weak. Tie this delegate's lifetime to
    // the webview without retaining it back or touching other windows.
    static KEY: u8 = 0;
    unsafe {
        ffi::objc_setAssociatedObject(
            ptr::from_ref(view).cast_mut().cast(),
            ptr::from_ref(&KEY).cast(),
            Retained::as_ptr(&delegate).cast_mut().cast(),
            ffi::OBJC_ASSOCIATION_RETAIN_NONATOMIC,
        );
        view.setUIDelegate(Some(ProtocolObject::from_ref(&*delegate)));
    }
}
