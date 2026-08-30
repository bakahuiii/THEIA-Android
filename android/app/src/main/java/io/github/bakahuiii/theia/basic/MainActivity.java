package io.github.bakahuiii.theia.basic;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(CasAuthPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
